import type { Core } from '@strapi/strapi';
import {
  IGNORED_CONTENT_TYPES,
  PLUGIN_NAME,
  WRITE_ACTIONS,
  type Category,
  type WriteAction,
} from '../constants';
import {
  ADMIN_USER_SELECT,
  ADMIN_USER_TRACKED,
  adminUserFields,
  diffAdminUser,
  diffPermissions,
  diffRole,
  type PermissionLabels,
  type PermissionRow,
} from '../core/admin-diff';
import { adminActor, resolveActor, requestInfo, type RequestLike } from '../core/actor';
import {
  buildPopulate,
  diffDocumentDetailed,
  summariseRelationWrite,
  type AttributeInfo,
  type DiffResult,
  type ModelLookup,
  type SchemaInfo,
} from '../core/diff';
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

/** Actions that compare the draft with the published version, rather than with `data`. */
const VERSION_ACTIONS = new Set<WriteAction>(['publish', 'discardDraft']);

const LOGIN_PATH = '/admin/login';

/** The Roles screen saves a role's whole permission set here in one request. */
const ROLE_PERMISSIONS_PATH = /^\/admin\/roles\/([^/]+)\/permissions\/?$/;

/** Key on `ctx.state` marking a request whose permission events are summarised in one entry. */
const PERMISSIONS_HANDLED = 'cmsAuditLogPermissions';

const ADMIN_USER = 'admin::user';
const ADMIN_ROLE = 'admin::role';

/** Lifecycle event, as `strapi.db.lifecycles` passes it to a subscriber. */
export interface LifecycleEvent {
  model?: { uid?: string };
  params?: { where?: Record<string, unknown>; data?: Record<string, unknown> };
  state?: Record<string, unknown>;
}

function idFromWhere(where: Record<string, unknown> | undefined): string | undefined {
  const id = where?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

const capitalise = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

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

  function schemaOf(uid: string): SchemaInfo | undefined {
    const model = strapi.getModel(uid as never) as
      | { attributes?: Record<string, AttributeInfo>; info?: { displayName?: string } }
      | undefined;
    return model?.attributes ? { attributes: model.attributes, displayName: model.info?.displayName } : undefined;
  }

  const models: ModelLookup = { component: schemaOf, contentType: schemaOf };

  /** The locale a Document Service call without one acts on: the default locale. */
  async function localeOf(uid: string, locale: string | undefined): Promise<string | undefined> {
    if (!isLocalized(uid)) return undefined;
    if (locale && locale !== '*') return locale;

    const locales = strapi.plugin('i18n')?.service('locales') as { getDefaultLocale?: () => Promise<string> } | undefined;
    const fallback = await locales?.getDefaultLocale?.();
    if (!fallback) throw new Error('default locale unknown');
    return fallback;
  }

  /**
   * One stored version, read with the query engine.
   *
   * Same rows and the same shape as `strapi.documents().findOne()`, without the Document
   * Service's per-relation draft/published handling: on a page builder with files and relations
   * in every section that took a deep load from about 150 ms to about 25 ms.
   */
  async function loadFast(
    uid: string,
    documentId: string,
    locale: string | undefined,
    keys: readonly string[] | undefined,
    status: 'draft' | 'published'
  ): Promise<Record<string, unknown> | null> {
    const attributes = schemaOf(uid)?.attributes ?? {};
    const where: Record<string, unknown> = { documentId };
    if (hasDraftAndPublish(uid)) where.publishedAt = status === 'draft' ? null : { $notNull: true };
    const resolvedLocale = await localeOf(uid, locale);
    if (resolvedLocale) where.locale = resolvedLocale;

    const populate = keys && keys.length > 0 ? buildPopulate(attributes, models, keys, 0, 'query') : undefined;
    const query = strapi.db.query(uid as never) as unknown as {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    };
    return (await query.findOne(populate ? { where, populate } : { where })) ?? null;
  }

  /**
   * Reads a stored version of a document for the diff, with the given fields populated to their
   * full depth. Failure is not fatal: without the before state the entry is still written, with
   * every submitted field shown as new.
   */
  async function loadDocument(
    uid: string,
    documentId: string,
    locale: string | undefined,
    keys: readonly string[] | undefined,
    status: 'draft' | 'published' = 'draft'
  ): Promise<Record<string, unknown> | null> {
    try {
      return await loadFast(uid, documentId, locale, keys, status);
    } catch (fastError) {
      strapi.log.debug(
        `[${PLUGIN_NAME}] Query engine read of ${uid} ${documentId} failed, using the Document Service: ${
          fastError instanceof Error ? fastError.message : String(fastError)
        }`
      );
    }

    try {
      const query: Record<string, unknown> = { documentId };
      if (locale && locale !== '*' && isLocalized(uid)) query.locale = locale;
      if (hasDraftAndPublish(uid)) query.status = status;
      const populate = keys && keys.length > 0 ? buildPopulate(schemaOf(uid)?.attributes ?? {}, models, keys) : undefined;
      if (populate) query.populate = populate;

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

  /**
   * What to load around a create or update: the components, dynamic zones and files the save
   * sent, to their full depth, and the relations it actually touched. An untouched relation is
   * left unloaded; on a large many-to-many that is most of the cost.
   */
  function populateFor(
    attributes: Record<string, AttributeInfo>,
    data: Record<string, unknown> | undefined
  ): string[] | undefined {
    if (!data) return undefined;

    const keys = Object.keys(data).filter((field) => {
      const type = attributes[field]?.type;
      if (!type) return false;
      if (POPULATED_TYPES.has(type)) return true;
      return type === 'relation' && summariseRelationWrite(data[field]) !== null;
    });
    return keys.length > 0 ? keys : undefined;
  }

  // --- Admin users, roles and permissions ------------------------------------------------------

  /**
   * Updates already recorded with a before/after diff, so the event hub's after-only copy of the
   * same update is skipped. Keyed by `uid:id`; entries expire quickly in case an event never
   * arrives.
   */
  const recordedUpdates = new Map<string, number>();
  const MARKER_TTL_MS = 10_000;

  function markRecorded(uid: string, id: string) {
    const now = Date.now();
    for (const [key, expires] of recordedUpdates) if (expires < now) recordedUpdates.delete(key);
    recordedUpdates.set(`${uid}:${id}`, now + MARKER_TTL_MS);
  }

  function takeRecorded(uid: string, id: string | undefined): boolean {
    if (!id) return false;
    const key = `${uid}:${id}`;
    const expires = recordedUpdates.get(key);
    recordedUpdates.delete(key);
    return expires !== undefined && expires >= Date.now();
  }

  type QueryApi = {
    findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    findMany(params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  };
  const query = (uid: string) => strapi.db.query(uid as never) as unknown as QueryApi;

  /** An admin user or role as the log shows it. Never selects passwords or tokens. */
  async function loadAdminRow(uid: string, id: string): Promise<Record<string, unknown> | null> {
    if (uid === ADMIN_USER) {
      return query(ADMIN_USER).findOne({
        where: { id },
        select: ADMIN_USER_SELECT,
        populate: { roles: { select: ['id', 'name'] } },
      });
    }
    return query(ADMIN_ROLE).findOne({ where: { id }, select: ['id', 'name', 'description', 'code'] });
  }

  async function loadPermissions(roleId: string): Promise<PermissionRow[]> {
    const rows = await query('admin::permission').findMany({
      where: { role: { id: roleId } },
      select: ['action', 'subject', 'properties', 'conditions'],
    });
    return rows.map((row) => ({
      action: String(row.action),
      subject: typeof row.subject === 'string' ? row.subject : null,
      properties: (row.properties as Record<string, unknown> | null) ?? null,
      conditions: Array.isArray(row.conditions) ? row.conditions : [],
    }));
  }

  /** Names for actions, subjects and conditions, as the Roles screen shows them. */
  function permissionLabels(): PermissionLabels {
    type Definition = {
      displayName?: string;
      section?: string;
      category?: string;
      subCategory?: string;
      pluginName?: string;
      plugin?: string;
    };
    let providers: { actionProvider?: { get?(id: string): Definition | undefined }; conditionProvider?: { get?(id: string): Definition | undefined } } = {};
    try {
      providers = strapi.service('admin::permission') as typeof providers;
    } catch {
      // Labels fall back to the raw ids.
    }
    const definition = (action: string) => {
      try {
        return providers.actionProvider?.get?.(action);
      } catch {
        return undefined;
      }
    };

    return {
      group(action, subject) {
        if (subject) {
          const model = strapi.getModel(subject as never) as { info?: { displayName?: string } } | undefined;
          return `Content › ${model?.info?.displayName ?? subject}`;
        }
        const def = definition(action);
        if (def?.section === 'plugins') {
          return ['Plugins', def.pluginName ?? def.plugin, def.subCategory].filter(Boolean).map((part) => capitalise(String(part))).join(' › ');
        }
        if (def?.section === 'settings') {
          return ['Settings', def.category, def.subCategory].filter(Boolean).map((part) => capitalise(String(part))).join(' › ');
        }
        return 'Other';
      },
      action(action) {
        return definition(action)?.displayName ?? action.split('.').pop() ?? action;
      },
      condition(id) {
        try {
          return providers.conditionProvider?.get?.(id)?.displayName ?? id;
        } catch {
          return id;
        }
      },
    };
  }

  /** Fills in role names when an event payload only carries role ids. */
  async function withRoleNames(user: Record<string, unknown> | undefined) {
    if (!user || !Array.isArray(user.roles)) return user;
    const roles = user.roles as unknown[];
    if (roles.every((role) => role && typeof role === 'object' && 'name' in (role as object))) return user;

    const ids = roles.map((role) => (role && typeof role === 'object' ? (role as { id?: unknown }).id : role));
    try {
      const found = await query(ADMIN_ROLE).findMany({ where: { id: { $in: ids } }, select: ['id', 'name'] });
      return { ...user, roles: found };
    } catch {
      return user;
    }
  }

  function diff(
    mode: 'create' | 'update' | 'compare',
    attributes: Record<string, AttributeInfo>,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    current: PluginSettings,
    data?: Record<string, unknown>
  ): DiffResult {
    return diffDocumentDetailed({
      mode,
      data,
      before,
      after,
      attributes,
      isSensitive: createSensitiveKeyMatcher(current.redactedFields),
      getComponent: (componentUid) => models.component(componentUid),
    });
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
      const manyLocales = Array.isArray(params.locale) || params.locale === '*';
      const populate = action === 'update' || action === 'create' ? populateFor(attributes, data) : undefined;

      const before =
        documentId && (action === 'update' || action === 'delete')
          ? await loadDocument(uid, documentId, locale, action === 'update' ? populate : undefined)
          : null;

      // Publishing replaces the live version with the draft; discarding replaces the draft with
      // the live version. The version about to be replaced is read now, while it still exists.
      // The other one is not changed by the action, so it is read afterwards with the rest.
      const compareVersions =
        VERSION_ACTIONS.has(action) && Boolean(documentId) && !manyLocales && hasDraftAndPublish(uid);
      const everything = Object.keys(attributes);
      const replaced = compareVersions
        ? await loadDocument(uid, documentId as string, locale, everything, action === 'publish' ? 'published' : 'draft')
        : null;

      let result: unknown;
      let failure: unknown;
      try {
        result = await next();
      } catch (error) {
        failure = error;
      }
      const occurredAt = new Date();

      const record = async () => {
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

        let versions: { draft: Record<string, unknown> | null; published: Record<string, unknown> | null } | null =
          null;
        if (compareVersions && !failure) {
          const kept = await loadDocument(
            uid,
            documentId as string,
            locale,
            everything,
            action === 'publish' ? 'draft' : 'published'
          );
          versions = action === 'publish' ? { draft: kept, published: replaced } : { draft: replaced, published: kept };
        }

        let found: DiffResult | undefined;
        if ((action === 'update' || action === 'create') && data) {
          found = diff(action, attributes, before, after, current, data);
        } else if (!failure && versions?.draft) {
          // publish: live version → draft that went live. discardDraft: draft → live version.
          if (action === 'publish' && versions.published) {
            found = diff('compare', attributes, versions.published, versions.draft, current);
          } else if (action === 'discardDraft' && versions.published) {
            found = diff('compare', attributes, versions.draft, versions.published, current);
          }
        }
        const changes: FieldChange[] | undefined = found?.changes;

        const model = strapi.getModel(uid as never) as
          | { info?: { displayName?: string }; kind?: string }
          | undefined;

        const details: Record<string, unknown> = {
          contentType: model?.info?.displayName,
          kind: model?.kind,
        };
        if (failure) details.error = errorSummary(failure);
        if (action === 'clone' && documentId) details.sourceDocumentId = documentId;
        if (manyLocales) details.allLocales = true;
        if (action === 'update' && !failure && changes && changes.length === 0) details.unchanged = true;
        if (found && found.omitted > 0) details.changesOmitted = found.omitted;
        if (action === 'publish' && !failure && versions) {
          if (!versions.published) details.firstPublish = true;
          else if (changes && changes.length === 0) details.sameAsLive = true;
        }
        if (action === 'discardDraft' && !failure && versions && changes && changes.length === 0) {
          details.sameAsLive = true;
        }

        enqueue(
          {
            action: ACTION_NAMES[action],
            category: 'content',
            outcome: failure ? 'failure' : 'success',
            actor,
            request: requestInfo(ctx),
            targetUid: uid,
            targetId: action === 'clone' ? (documentIdOf(result) ?? documentId) : targetId,
            targetLabel: entryLabel(
              after ?? before ?? versions?.draft ?? firstEntry ?? (result as Record<string, unknown>) ?? data
            ),
            localeCode: locale && locale !== '*' ? locale : undefined,
            changes,
            details,
            occurredAt,
          },
          current
        );
      };

      const recordSafely = async () => {
        try {
          await record();
        } catch (error) {
          strapi.log.error(
            `[${PLUGIN_NAME}] Could not record ${action} on ${uid}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      };

      // Read back before answering. Deferring this to after the response was tried and measured:
      // it saved about 25 ms on a large page, but a quick second save (or Save then Publish) could
      // land first, and its changes were then attributed to this entry.
      await recordSafely();

      if (failure) throw failure;
      return result;
    },

    /**
     * Database lifecycle subscriber for admin users and roles.
     *
     * Strapi's `user.update` and `role.update` events carry only the new state. This reads the row
     * before the write and again after it, so the entry can say what changed: "Roles: Editor →
     * Author", "Active: Yes → No". Subscribed at the database level, it covers every way an admin
     * user is changed: the Users screen, the profile page, invite acceptance and SSO.
     */
    adminLifecycles() {
      const uidOf = (event: LifecycleEvent) => event.model?.uid;

      return {
        models: [ADMIN_USER, ADMIN_ROLE],

        async beforeUpdate(event: LifecycleEvent) {
          try {
            const uid = uidOf(event);
            const id = idFromWhere(event.params?.where);
            if (!uid || !id || !event.state) return;
            event.state.auditBefore = await loadAdminRow(uid, id);
          } catch {
            // Without a before state the event hub entry is recorded instead.
          }
        },

        async afterUpdate(event: LifecycleEvent) {
          try {
            const uid = uidOf(event);
            const id = idFromWhere(event.params?.where);
            const before = event.state?.auditBefore as Record<string, unknown> | null | undefined;
            if (!uid || !id || before === undefined) return;

            const data = event.params?.data ?? {};
            const isUser = uid === ADMIN_USER;

            // Token and bookkeeping writes (password reset tokens, registration tokens) are not
            // an editor's change. Skip them, and their event hub copy with them.
            if (isUser && !Object.keys(data).some((key) => ADMIN_USER_TRACKED.has(key))) {
              markRecorded(uid, id);
              return;
            }

            const after = await loadAdminRow(uid, id);
            const changes = isUser ? diffAdminUser(before, after, data) : diffRole(before, after);
            markRecorded(uid, id);

            // The Roles screen saves the name with every permission change; an unchanged name is
            // noise next to the permissions entry.
            if (!isUser && changes.length === 0) return;

            const ctx = currentRequest();
            let actor = resolveActor(ctx);
            const details: Record<string, unknown> = {};
            if (actor.type === 'anonymous' && ctx && isUser && after) {
              // Accepting an invite: the person setting their password is the user themselves.
              actor = adminActor(after);
              details.selfService = true;
            }
            if (changes.length === 0) details.unchanged = true;

            const category: Category = isUser ? 'admin-user' : 'role';
            const current = await settings();
            if (!shouldRecord(current, category, actor, uid)) return;

            const label = (after ?? before) as Record<string, unknown> | null;
            enqueue(
              {
                action: isUser ? 'admin-user.update' : 'role.update',
                category,
                outcome: 'success',
                actor,
                request: requestInfo(ctx),
                targetUid: uid,
                targetId: id,
                targetLabel:
                  typeof (isUser ? label?.email : label?.name) === 'string'
                    ? String(isUser ? label?.email : label?.name)
                    : undefined,
                changes,
                details: Object.keys(details).length > 0 ? details : undefined,
                occurredAt: new Date(),
              },
              current
            );
          } catch (error) {
            strapi.log.error(
              `[${PLUGIN_NAME}] Could not record an admin ${event.model?.uid ?? ''} update: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        },
      };
    },

    /**
     * Koa middleware turning a role's permission save into one entry.
     *
     * The Roles screen sends the role's whole permission set in one request, and Strapi records
     * it as a burst of `permission.create` / `permission.delete` events that say nothing about
     * which content type or action changed. This reads the role's permissions before and after
     * the request and records one entry listing what was granted, revoked and narrowed.
     */
    permissionsMiddleware() {
      return async (ctx: RequestLike & { status?: number; state?: Record<string, unknown> }, next: Next) => {
        const match = ctx.method === 'PUT' ? ROLE_PERMISSIONS_PATH.exec(ctx.path ?? '') : null;
        if (!match) return next();

        const roleId = decodeURIComponent(match[1]);
        let before: PermissionRow[] | null = null;
        try {
          before = await loadPermissions(roleId);
        } catch {
          before = null; // the event hub entries are recorded instead
        }
        if (before) {
          ctx.state = ctx.state ?? {};
          ctx.state[PERMISSIONS_HANDLED] = true;
        }

        let thrown: unknown;
        try {
          await next();
        } catch (error) {
          thrown = error;
          throw error;
        } finally {
          if (before) {
            try {
              const status = thrown ? statusOfThrown(thrown) : Number(ctx.status ?? 200);
              const actor = resolveActor(ctx);
              const current = await settings();
              // An unauthenticated request changed nothing and was refused before reaching the
              // role. (No `return` here: inside `finally` it would swallow the thrown error.)
              const refused = (status === 401 || status === 403) && actor.type === 'anonymous';

              if (!refused && shouldRecord(current, 'role', actor, ADMIN_ROLE)) {
                const after = await loadPermissions(roleId);
                const changes = diffPermissions(before, after, permissionLabels());
                const role = await loadAdminRow(ADMIN_ROLE, roleId).catch(() => null);
                const failed = status >= 400;

                const details: Record<string, unknown> = {};
                if (failed) details.status = status;
                if (!failed && changes.length === 0) details.unchanged = true;

                enqueue(
                  {
                    action: 'role.permissions.update',
                    category: 'role',
                    outcome: failed ? 'failure' : 'success',
                    actor,
                    request: requestInfo(ctx),
                    targetUid: ADMIN_ROLE,
                    targetId: roleId,
                    targetLabel: typeof role?.name === 'string' ? role.name : undefined,
                    changes,
                    details: Object.keys(details).length > 0 ? details : undefined,
                    occurredAt: new Date(),
                  },
                  current
                );
              }
            } catch (error) {
              strapi.log.error(
                `[${PLUGIN_NAME}] Could not record a permission change on role ${roleId}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
      };
    },

    /** Event hub subscriber for media, auth, admin users, roles and schema changes. */
    async handleEvent(name: string, payload: unknown): Promise<void> {
      try {
        const mapped = mapEvent(name, payload as Record<string, unknown> | undefined);
        if (!mapped) return;

        const ctx = currentRequest();
        const body = (payload ?? {}) as Record<string, unknown>;
        const rowId = (key: 'user' | 'role') => {
          const id = (body[key] as { id?: unknown } | undefined)?.id;
          return id === undefined || id === null ? undefined : String(id);
        };

        // Already recorded with a before/after diff by `adminLifecycles` or
        // `permissionsMiddleware`; this is the after-only copy of the same change.
        if (name.startsWith('permission.') && (ctx?.state as Record<string, unknown> | undefined)?.[PERMISSIONS_HANDLED]) {
          return;
        }
        if (name === 'user.update' && takeRecorded(ADMIN_USER, rowId('user'))) return;
        if (name === 'role.update' && takeRecorded(ADMIN_ROLE, rowId('role'))) return;

        let actor = mapped.actorOverride ?? resolveActor(ctx);
        let details = mapped.details;
        let changes: FieldChange[] | undefined;

        // An invite or a delete: the user's details as added or removed fields, roles by name.
        if (name === 'user.create' || name === 'user.delete') {
          const user = await withRoleNames(body.user as Record<string, unknown> | undefined);
          changes = adminUserFields(user, name === 'user.create' ? 'added' : 'removed');
          details = undefined;
        }

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
            changes,
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
