import type { Core } from '@strapi/strapi';
import { SETTING_BOUNDS } from '../config';
import { CATEGORIES, PLUGIN_NAME, SETTINGS_STORE_KEY, type Category } from '../constants';

/**
 * Settings an administrator can change at runtime from Settings → Audit Log.
 *
 * Kept deliberately narrow. Anything that weakens the log's protection (the signing secret, the
 * export ceiling, the rate limits) is config-file only.
 */
export interface PluginSettings {
  retentionDays: number;
  /** Record writes made through the Content API with API tokens or end-user logins. */
  captureContentApi: boolean;
  /** Record writes with no request behind them: seed scripts, cron jobs, other plugins at boot. */
  captureSystem: boolean;
  disabledCategories: Category[];
  excludedContentTypes: string[];
  /** Field names redacted in addition to the built-in list (passwords, tokens, secrets). */
  redactedFields: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  retentionDays: SETTING_BOUNDS.retentionDays.default,
  captureContentApi: true,
  captureSystem: false,
  disabledCategories: [],
  excludedContentTypes: [],
  redactedFields: [],
};

const UID_PATTERN = /^(api|plugin|admin)::[a-z0-9-]+\.[a-z0-9-]+$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_LIST = 200;

/** `audit` cannot be switched off: the log of who changed the log's own settings must stay. */
export const LOCKED_CATEGORIES: readonly Category[] = ['audit'];

export type SettingsValidation =
  | { ok: true; value: PluginSettings }
  | { ok: false; message: string; field: string };

function stringList(
  field: string,
  raw: unknown,
  pattern: RegExp
): { ok: true; value: string[] } | { ok: false; message: string; field: string } {
  if (!Array.isArray(raw)) return { ok: false, field, message: `${field} must be a list.` };
  if (raw.length > MAX_LIST) {
    return { ok: false, field, message: `${field} accepts at most ${MAX_LIST} values.` };
  }

  const values = raw.map((value) => (typeof value === 'string' ? value.trim() : ''));
  const bad = values.find((value) => !pattern.test(value));
  if (bad !== undefined) {
    return { ok: false, field, message: `${field} contains an invalid value: "${bad.slice(0, 80)}".` };
  }

  return { ok: true, value: [...new Set(values)] };
}

/**
 * Validates a settings patch against the current settings. Unknown keys are rejected rather
 * than ignored, so a typo in an API call fails instead of silently doing nothing (mass
 * assignment, OWASP API3).
 */
export function validateSettings(current: PluginSettings, patch: unknown): SettingsValidation {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, field: 'body', message: 'The settings must be an object.' };
  }

  const input = patch as Record<string, unknown>;
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return { ok: false, field: unknown, message: `Unknown setting "${unknown.slice(0, 40)}".` };

  const next: PluginSettings = { ...current };

  if (input.retentionDays !== undefined) {
    const value = Number(input.retentionDays);
    const bounds = SETTING_BOUNDS.retentionDays;
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      return {
        ok: false,
        field: 'retentionDays',
        message: `retentionDays must be a whole number between ${bounds.min} and ${bounds.max}.`,
      };
    }
    next.retentionDays = value;
  }

  for (const key of ['captureContentApi', 'captureSystem'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') {
      return { ok: false, field: key, message: `${key} must be true or false.` };
    }
    next[key] = input[key] as boolean;
  }

  if (input.disabledCategories !== undefined) {
    const result = stringList('disabledCategories', input.disabledCategories, /^[a-z-]+$/);
    if (!result.ok) return result;

    const bad = result.value.find((value) => !(CATEGORIES as readonly string[]).includes(value));
    if (bad) return { ok: false, field: 'disabledCategories', message: `Unknown category "${bad}".` };

    const locked = result.value.find((value) => LOCKED_CATEGORIES.includes(value as Category));
    if (locked) {
      return {
        ok: false,
        field: 'disabledCategories',
        message: `The "${locked}" category records changes to the audit log itself and cannot be turned off.`,
      };
    }
    next.disabledCategories = result.value as Category[];
  }

  if (input.excludedContentTypes !== undefined) {
    const result = stringList('excludedContentTypes', input.excludedContentTypes, UID_PATTERN);
    if (!result.ok) return result;
    next.excludedContentTypes = result.value;
  }

  if (input.redactedFields !== undefined) {
    const result = stringList('redactedFields', input.redactedFields, FIELD_PATTERN);
    if (!result.ok) return result;
    next.redactedFields = result.value;
  }

  return { ok: true, value: next };
}

/** Field-level differences between two settings objects, for the audit entry of a change. */
export function settingsChanges(before: PluginSettings, after: PluginSettings) {
  return (Object.keys(after) as Array<keyof PluginSettings>)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ field: key, before: before[key], after: after[key], kind: 'value' as const }));
}

/**
 * Settings are read on every captured write, so they are cached. The short TTL bounds how long
 * another instance behind a load balancer keeps using settings this one has replaced.
 */
const CACHE_TTL_MS = 10_000;

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: PLUGIN_NAME, key: SETTINGS_STORE_KEY });
  let cache: { value: PluginSettings; at: number } | null = null;

  function normalise(stored: unknown): PluginSettings {
    const merged = { ...DEFAULT_SETTINGS, ...((stored as Partial<PluginSettings>) ?? {}) };
    const result = validateSettings(DEFAULT_SETTINGS, merged);

    if (!result.ok) {
      strapi.log.warn(
        `[${PLUGIN_NAME}] Stored settings are invalid (${result.message}); using defaults until they are saved again.`
      );
      return { ...DEFAULT_SETTINGS };
    }
    return result.value;
  }

  return {
    async ensureDefaults(): Promise<void> {
      const existing = await store().get({});
      if (existing) return;

      const seed = (strapi.config.get(`plugin::${PLUGIN_NAME}.defaults`) ?? {}) as Record<string, unknown>;
      const result = validateSettings(DEFAULT_SETTINGS, seed);
      if (!result.ok) {
        strapi.log.error(`[${PLUGIN_NAME}] config defaults rejected: ${result.message}`);
      }

      await store().set({ value: result.ok ? result.value : DEFAULT_SETTINGS });
      cache = null;
    },

    async get(): Promise<PluginSettings> {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

      const value = normalise(await store().get({}));
      cache = { value, at: Date.now() };
      return value;
    },

    async update(patch: unknown) {
      const before = await this.get();
      const result = validateSettings(before, patch);
      if (!result.ok) return result;

      await store().set({ value: result.value });
      cache = { value: result.value, at: Date.now() };

      return { ok: true as const, value: result.value, changes: settingsChanges(before, result.value) };
    },

    invalidate() {
      cache = null;
    },
  };
};
