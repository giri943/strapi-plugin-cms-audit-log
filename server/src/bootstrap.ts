import { AsyncResource } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';
import type { PluginSettings } from './services/settings';

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let unsubscribe: (() => void) | null = null;
let unsubscribeLifecycles: Array<() => void> = [];
let pruneTimer: NodeJS.Timeout | null = null;

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = strapi.plugin(PLUGIN_NAME);

  try {
    await plugin.service('settings').ensureDefaults();
  } catch (error) {
    strapi.log.error(`[${PLUGIN_NAME}] Could not write default settings.`, error);
  }

  plugin.service('writer').start();

  // Every event, filtered by name in `capture.handleEvent`. `subscribe` is the only hook that
  // sees events without listing them up front, and the list differs across 5.x minor versions.
  unsubscribe = strapi.eventHub.subscribe((name: string, ...args: unknown[]) =>
    plugin.service('capture').handleEvent(name, args[0])
  ) as unknown as () => void;

  // Admin users, roles, media files and folders are read before and after each write, for a
  // before/after diff.
  const lifecycles = strapi.db.lifecycles as unknown as { subscribe(subscriber: unknown): unknown };
  for (const [name, subscriber] of [
    ['admin user and role', () => plugin.service('capture').adminLifecycles()],
    ['media', () => plugin.service('capture').mediaLifecycles()],
  ] as const) {
    try {
      const result = lifecycles.subscribe(subscriber());
      if (typeof result === 'function') unsubscribeLifecycles.push(result as () => void);
    } catch (error) {
      strapi.log.error(`[${PLUGIN_NAME}] Could not watch ${name} changes.`, error);
    }
  }

  /**
   * Retention runs on a plain timer rather than `strapi.cron`, because cron jobs only run when
   * the project sets `server.cron.enabled`, and a log that silently never expires is a storage
   * problem waiting to happen. Deleting by date is idempotent, so several instances doing it is
   * harmless.
   */
  const prune = AsyncResource.bind(async () => {
    try {
      const settings = (await plugin.service('settings').get()) as PluginSettings;
      const removed = await plugin.service('logs').prune(settings.retentionDays);
      if (removed > 0) {
        await plugin.service('capture').recordAudit('audit.retention.prune', {
          details: { removed, retentionDays: settings.retentionDays },
        });
        strapi.log.info(`[${PLUGIN_NAME}] Removed ${removed} audit row(s) older than ${settings.retentionDays} days.`);
      }
    } catch (error) {
      strapi.log.warn(
        `[${PLUGIN_NAME}] Retention pass failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  void prune();
  pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
};

export const stopBackgroundWork = () => {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeLifecycles.forEach((stop) => stop());
  unsubscribeLifecycles = [];
};

export default bootstrap;
