import { AsyncResource } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { AUDIT_LOG_UID, LIMITS, PLUGIN_NAME } from '../constants';
import { boundedDetails, columnString, createSensitiveKeyMatcher, redactValue } from '../core/redact';
import { deriveKey, signRow, verifyRow, type Integrity } from '../core/signature';
import type { AuditEntry, AuditRow, FieldChange } from '../core/types';
import type { PluginConfig } from '../config';

export type KeySource = 'config' | 'admin-secret' | 'none';

/**
 * Turns an entry into a row: every column bounded to its width, every free-form value
 * redacted, and JSON round-tripped so what is signed is exactly what the database can store.
 */
export function toRow(entry: AuditEntry, redactedFields: readonly string[] = []): AuditRow {
  const isSensitive = createSensitiveKeyMatcher(redactedFields);

  const changes: FieldChange[] | null =
    entry.changes && entry.changes.length > 0
      ? entry.changes.slice(0, LIMITS.maxChangesPerEntry).map((change) => {
          const out: FieldChange = { field: change.field };
          if (change.kind) out.kind = change.kind;
          if (change.kind === 'redacted' || isSensitive(change.field)) {
            out.kind = 'redacted';
            return out;
          }
          if (change.before !== undefined) out.before = redactValue(change.before, isSensitive);
          if (change.after !== undefined) out.after = redactValue(change.after, isSensitive);
          return out;
        })
      : null;

  const details = boundedDetails(entry.details, isSensitive);

  const row: AuditRow = {
    action: columnString(entry.action, 100) ?? 'unknown',
    category: entry.category,
    outcome: entry.outcome,
    actorType: entry.actor.type,
    actorId: columnString(entry.actor.id, 64),
    actorEmail: columnString(entry.actor.email),
    actorName: columnString(entry.actor.name),
    targetUid: columnString(entry.targetUid),
    targetId: columnString(entry.targetId, 64),
    targetLabel: columnString(entry.targetLabel, LIMITS.maxLabelChars),
    localeCode: columnString(entry.localeCode, 20),
    changes: changes ? JSON.parse(JSON.stringify(changes)) : null,
    details: details ? JSON.parse(JSON.stringify(details)) : null,
    ipAddress: columnString(entry.request?.ip, 64),
    userAgent: columnString(entry.request?.userAgent),
    requestMethod: columnString(entry.request?.method, 10),
    requestPath: columnString(entry.request?.path),
    occurredAt: new Date(Math.floor(entry.occurredAt.getTime() / 1000) * 1000).toISOString(),
  };

  return row;
}

/**
 * Buffered, signed writes.
 *
 * Capture sites call `enqueue` and return immediately; rows are inserted in batches. Two
 * reasons:
 *
 * 1. An editor's save must not wait on, or fail because of, the audit insert.
 * 2. The Document Service runs inside a database transaction tracked with AsyncLocalStorage.
 *    A query issued from that async context joins the transaction, so an audit insert there
 *    would roll back with a failed save (losing the failure record) or run against a
 *    transaction that has already committed. `flush` is bound to the bootstrap context with
 *    `AsyncResource.bind`, which runs it outside any request or transaction.
 */
export default ({ strapi }: { strapi: Core.Strapi }) => {
  const queue: AuditRow[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;
  let dropped = 0;
  let lastErrorLog = 0;
  let key: Buffer | null = null;
  let keySource: KeySource = 'none';
  let boundFlush: (() => Promise<void>) | null = null;

  const config = () => strapi.config.get(`plugin::${PLUGIN_NAME}`) as PluginConfig;

  function resolveKey() {
    const configured = config()?.signingSecret;
    if (typeof configured === 'string' && configured.length > 0) {
      key = deriveKey(configured);
      keySource = 'config';
      return;
    }

    const adminSecret = strapi.config.get('admin.auth.secret') as string | undefined;
    if (typeof adminSecret === 'string' && adminSecret.length > 0) {
      key = deriveKey(adminSecret);
      keySource = 'admin-secret';
      strapi.log.warn(
        `[${PLUGIN_NAME}] No signingSecret configured; audit rows are signed with a key derived from admin.auth.secret. Rotating that secret will make existing rows fail verification. Set plugins['${PLUGIN_NAME}'].config.signingSecret to avoid this.`
      );
      return;
    }

    key = null;
    keySource = 'none';
    strapi.log.error(`[${PLUGIN_NAME}] No signing key available; audit rows will be stored unsigned.`);
  }

  async function writeBatch(rows: AuditRow[]) {
    await strapi.db.query(AUDIT_LOG_UID).createMany({ data: rows as unknown as Record<string, unknown>[] });
  }

  async function flushNow(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, LIMITS.flushBatchSize);

      try {
        await writeBatch(batch);
      } catch (error) {
        // Put the batch back once so a transient failure (lock timeout, restart of the
        // database) does not lose it, then stop until the next tick.
        if (queue.length + batch.length <= LIMITS.maxQueueLength) queue.unshift(...batch);
        else dropped += batch.length;

        if (Date.now() - lastErrorLog > 60_000) {
          lastErrorLog = Date.now();
          strapi.log.error(
            `[${PLUGIN_NAME}] Could not write ${batch.length} audit row(s); will retry. ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        return;
      }
    }

    if (dropped > 0) {
      strapi.log.error(`[${PLUGIN_NAME}] ${dropped} audit row(s) were dropped because the write queue was full.`);
      dropped = 0;
    }
  }

  function flush(): Promise<void> {
    if (!flushing) {
      flushing = flushNow().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    start() {
      resolveKey();
      boundFlush = AsyncResource.bind(flush);
      timer = setInterval(boundFlush, LIMITS.flushIntervalMs);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await flush();
    },

    enqueue(entry: AuditEntry, redactedFields: readonly string[] = []) {
      const row = toRow(entry, redactedFields);
      if (key) row.signature = signRow(row, key);

      if (queue.length >= LIMITS.maxQueueLength) {
        dropped += 1;
        return;
      }
      queue.push(row);

      if (queue.length >= LIMITS.flushBatchSize && boundFlush) void boundFlush();
    },

    /** Writes everything queued. For tests and for the plugin's own audit entries. */
    flush,

    verify(row: Partial<AuditRow>): Integrity {
      if (!key) return row.signature ? 'unverifiable' : 'unsigned';
      return verifyRow(row, key);
    },

    keySource(): KeySource {
      return keySource;
    },

    pending(): number {
      return queue.length;
    },
  };
};
