import type { Core } from '@strapi/strapi';
import {
  IGNORED_CONTENT_TYPES,
  PLUGIN_NAME,
  WRITE_ACTIONS,
  type Category,
  type WriteAction,
} from '../constants';
import { resolveActor, requestInfo, type RequestLike } from '../core/actor';
import { diffDocument, type AttributeInfo } from '../core/diff';
import { mapEvent } from '../core/events';
import { entryLabel } from '../core/labels';
import { createSensitiveKeyMatcher } from '../core/redact';
import type { Actor, AuditEntry, FieldChange } from '../core/types';
import type { PluginConfig } from '../config';
import type { PluginSettings } from './settings';

/** The context object the Document Service hands its middlewares. */
export interface DocumentContext {
  action: string;
  uid: string;
  params?: Record<string, unknown>;
  contentType?: { attributes?: Record<string, AttributeInfo> };
}

type Next = () => Promise<unknown>;

const ACTION_NAMES: Record<WriteAction, string> = {
  create: 'entry.create',
  update: 'entry.update',
  delete: 'entry.delete',
  publish: 'entry.publish',
  unpublish: 'entry.unpublish',
  discardDraft: 'entry.discard-draft',
  clone: 'entry.clone',
};

/** Attribute types whose stored value is only visible with `populate`. */
const POPULATED_TYPES = new Set(['component', 'dynamiczone', 'media']);

const LOGIN_PATH = '/admin/login';

/**
 * The status Strapi's error middleware will give a thrown error.
 *
 * This hook runs outside that middleware, so it sees the raw error. Strapi's own error classes
 * often carry no `status` (Strapi 5.0 throws a bare `ApplicationError` for wrong credentials)
 * and are mapped by class instead. The names are checked rather than `instanceof`, because the
 * error may come from a different copy of `@strapi/utils`.
 */
const STATUS_BY_ERROR_NAME: Record<string, number> = {
  ApplicationError: 400,
  ValidationError: 400,
  YupValidationError: 400,
  PaginationError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  PolicyError: 403,
  NotFoundError: 404,
  PayloadTooLargeError: 413,
  RateLimitError: 429,
};

export function statusOfThrown(error: unknown): number {
  if (!error || typeof error !== 'object') return 500;

  const record = error as { status?: unknown; statusCode?: unknown; name?: unknown };
  const explicit = Number(record.status ?? record.statusCode);
  if (Number.isInteger(explicit) && explicit >= 100 && explicit < 600) return explicit;

  return typeof record.name === 'string' ? (STATUS_BY_ERROR_NAME[record.name] ?? 500) : 500;
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message.slice(0, 300) : undefined,
      status: typeof record.status === 'number' ? record.status : undefined,
    };
  }
  return { name: 'Error' };
}

function documentIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).documentId;
  return typeof id === 'string' ? id : undefined;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = () => strapi.plugin(PLUGIN_NAME);
  const config = () => (strapi.config.get(`plugin::${PLUGIN_NAME}`) ?? {}) as Partial<PluginConfig>;
  const settings = (): Promise<PluginSettings> => plugin().service('settings').get();

  function currentRequest(): RequestLike | undefined {
    try {
      return (strapi.requestContext?.get?.() as RequestLike | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether an action by this actor, in this category, on this type, should be recorded. */
  function shouldRecord(current: PluginSettings, category: Category, actor: Actor, uid?: string): boolean {
    if (config().enabled === false) return false;
    if (category === 'audit') return true;
    if (current.disabledCategories.includes(category)) return false;
    if (uid && current.excludedContentTypes.includes(uid)) return false;

    // Failed logins are anonymous by nature and are the point of the auth category.
    if (category === 'auth') return true;

    if (actor.type === 'system') return current.captureSystem;
    if (actor.type === 'api-token' || actor.type === 'end-user' || actor.type === 'anonymous') {
      return current.captureContentApi;
    }
    return true;
  }

  function enqueue(entry: AuditEntry, current: PluginSettings) {
    try {
      plugin().service('writer').enqueue(entry, current.redactedFields);
    } catch (error) {
      // Fail open: an audit failure is logged and the user's action carries on.
      strapi.log.error(
        `[${PLUGIN_NAME}] Could not queue audit entry ${entry.action}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  function isLocalized(uid: string): boolean {
    const model = strapi.getModel(uid as never) as { pluginOptions?: { i18n?: { localized?: boolean } } } | undefined;
    return model?.pluginOptions?.i18n?.localized === true;
  }

  function hasDraftAndPublish(uid: string): boolean {
    const model = strapi.getModel(uid as never) as { options?: { draftAndPublish?: boolean } } | undefined;
    return model?.options?.draftAndPublish === true;
  }

  /**
   * Reads the stored draft of a document for the diff. Failure is not fatal: without the
   * before state the entry is still written, with every submitted field shown as new.
   */
  async function loadDocument(
    uid: string,
    documentId: string,
    locale: string | undefined,
    populate: Record<string, true> | undefined
  ): Promise<Record<string, unknown> | null> {
    try {
      const query: Record<string, unknown> = { documentId };
      if (locale && locale !== '*' && isLocalized(uid)) query.locale = locale;
      if (hasDraftAndPublish(uid)) query.status = 'draft';
      if (populate && Object.keys(populate).length > 0) query.populate = populate;

      const documents = strapi.documents(uid as never) as unknown as {
        findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      };
      return (await documents.findOne(query)) ?? null;
    } catch (error) {
      strapi.log.debug(
        `[${PLUGIN_NAME}] Could not read ${uid} ${documentId} for the diff: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  function populateFor(
    attributes: Record<string, AttributeInfo>,
    data: Record<string, unknown> | undefined
  ): Record<string, true> | undefined {
    if (!data) return undefined;

    const populate: Record<string, true> = {};
    for (const field of Object.keys(data)) {
      const type = attributes[field]?.type;
      if (type && POPULATED_TYPES.has(type)) populate[field] = true;
    }
    return Object.keys(populate).length > 0 ? populate : undefined;
  }

  return {
    /**
     * Document Service middleware. Registered in `register()` so it wraps every document
     * write in the application, whichever plugin or controller makes it.
     */
    async handleDocument(context: DocumentContext, next: Next): Promise<unknown> {
      const action = context.action as WriteAction;
      if (!(WRITE_ACTIONS as readonly string[]).includes(action)) return next();
      if (IGNORED_CONTENT_TYPES.includes(context.uid)) return next();

      let current: PluginSettings;
      let actor: Actor;
      let ctx: RequestLike | undefined;

      try {
        current = await settings();
        ctx = currentRequest();
        actor = resolveActor(ctx);
        if (!shouldRecord(current, 'content', actor, context.uid)) return next();
      } catch {
        return next();
      }

      const uid = context.uid;
      const params = context.params ?? {};
      const data = (params.data && typeof params.data === 'object' ? params.data : undefined) as
        | Record<string, unknown>
        | undefined;
      const attributes = (context.contentType?.attributes ??
        (strapi.getModel(uid as never) as { attributes?: Record<string, AttributeInfo> } | undefined)
          ?.attributes ??
        {}) as Record<string, AttributeInfo>;
      const documentId = typeof params.documentId === 'string' ? params.documentId : undefined;
      const locale = typeof params.locale === 'string' ? params.locale : undefined;
      const populate = action === 'update' || action === 'create' ? populateFor(attributes, data) : undefined;

      const before =
        documentId && (action === 'update' || action === 'delete')
          ? await loadDocument(uid, documentId, locale, action === 'update' ? populate : undefined)
          : null;

      let result: unknown;
      let failure: unknown;
      try {
        result = await next();
      } catch (error) {
        failure = error;
      }

      try {
        const targetId = documentId ?? documentIdOf(result);
        const firstEntry = Array.isArray((result as { entries?: unknown[] })?.entries)
          ? ((result as { entries: Record<string, unknown>[] }).entries[0] ?? null)
          : null;

        let after: Record<string, unknown> | null = null;
        if (!failure && (action === 'update' || action === 'create')) {
          after =
            populate && targetId
              ? await loadDocument(uid, targetId, locale, populate)
              : ((result as Record<string, unknown>) ?? null);
        }

        let changes: FieldChange[] | undefined;
        if ((action === 'update' || action === 'create') && data) {
          changes = diffDocument({
            mode: action,
            data,
            before,
            after,
            attributes,
            isSensitive: createSensitiveKeyMatcher(current.redactedFields),
          });
        }

        const model = strapi.getModel(uid as never) as
          | { info?: { displayName?: string }; kind?: string }
          | undefined;

        const details: Record<string, unknown> = {
          contentType: model?.info?.displayName,
          kind: model?.kind,
        };
        if (failure) details.error = errorSummary(failure);
        if (action === 'clone' && documentId) details.sourceDocumentId = documentId;
        if (locale === '*') details.allLocales = true;
        if (action === 'update' && !failure && changes && changes.length === 0) details.unchanged = true;

        enqueue(
          {
            action: ACTION_NAMES[action],
            category: 'content',
            outcome: failure ? 'failure' : 'success',
            actor,
            request: requestInfo(ctx),
            targetUid: uid,
            targetId: action === 'clone' ? (documentIdOf(result) ?? documentId) : targetId,
            targetLabel: entryLabel(after ?? before ?? firstEntry ?? (result as Record<string, unknown>) ?? data),
            localeCode: locale && locale !== '*' ? locale : undefined,
            changes,
            details,
            occurredAt: new Date(),
          },
          current
        );
      } catch (error) {
        strapi.log.error(
          `[${PLUGIN_NAME}] Could not record ${action} on ${uid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      if (failure) throw failure;
      return result;
    },

    /** Event hub subscriber for media, auth, admin users, roles and schema changes. */
    async handleEvent(name: string, payload: unknown): Promise<void> {
      try {
        const mapped = mapEvent(name, payload as Record<string, unknown> | undefined);
        if (!mapped) return;

        const ctx = currentRequest();
        let actor = mapped.actorOverride ?? resolveActor(ctx);
        let details = mapped.details;

        // First-admin sign-up and invite acceptance run before any session exists.
        if (actor.type === 'anonymous' && ctx && mapped.fallbackActor) {
          actor = mapped.fallbackActor;
          details = { ...details, selfService: true };
        }

        const current = await settings();
        if (!shouldRecord(current, mapped.category, actor, mapped.targetUid)) return;

        enqueue(
          {
            action: mapped.action,
            category: mapped.category,
            outcome: 'success',
            actor,
            request: requestInfo(ctx),
            targetUid: mapped.targetUid,
            targetId: mapped.targetId,
            targetLabel: mapped.targetLabel,
            details,
            occurredAt: new Date(),
          },
          current
        );
      } catch (error) {
        strapi.log.error(
          `[${PLUGIN_NAME}] Could not record event ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },

    /**
     * Koa middleware recording failed admin logins (OWASP A07, A09).
     *
     * Strapi only started emitting a login-failure event in late 5.x, so the response status of
     * `POST /admin/login` is checked directly. The password in the body is never read.
     */
    loginFailureMiddleware() {
      return async (ctx: RequestLike & { status?: number; request?: { body?: unknown; ip?: string } }, next: Next) => {
        let thrown: unknown;
        try {
          await next();
        } catch (error) {
          thrown = error;
          throw error;
        } finally {
          if (ctx.method === 'POST' && ctx.path === LOGIN_PATH) {
            const status = thrown ? statusOfThrown(thrown) : Number(ctx.status ?? 200);

            if (status >= 400 && status < 500) {
              void (async () => {
                try {
                  const current = await settings();
                  const actor: Actor = { type: 'anonymous' };
                  if (!shouldRecord(current, 'auth', actor)) return;

                  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
                  const email =
                    typeof body.email === 'string' && body.email.length <= 255
                      ? body.email.trim().toLowerCase()
                      : undefined;

                  enqueue(
                    {
                      action: status === 429 ? 'admin.login.rate-limited' : 'admin.login.failed',
                      category: 'auth',
                      outcome: 'failure',
                      actor,
                      request: requestInfo(ctx),
                      targetUid: 'admin::user',
                      targetLabel: email,
                      details: { status },
                      occurredAt: new Date(),
                    },
                    current
                  );
                } catch {
                  // Never let audit bookkeeping affect the login response.
                }
              })();
            }
          }
        }
      };
    },

    /**
     * Records an action taken on the audit log itself: exports, settings changes, retention
     * pruning, integrity checks. Always recorded, whatever the category settings say.
     */
    async recordAudit(
      action: string,
      options: { changes?: FieldChange[]; details?: Record<string, unknown>; outcome?: 'success' | 'failure' } = {}
    ): Promise<void> {
      const current = await settings();
      const ctx = currentRequest();

      enqueue(
        {
          action,
          category: 'audit',
          outcome: options.outcome ?? 'success',
          actor: resolveActor(ctx),
          request: requestInfo(ctx),
          targetUid: `plugin::${PLUGIN_NAME}`,
          changes: options.changes,
          details: options.details,
          occurredAt: new Date(),
        },
        current
      );
    },
  };
};
