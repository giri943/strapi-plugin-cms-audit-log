import { CATEGORIES } from '../constants';

export const SETTING_BOUNDS = {
  retentionDays: { min: 1, max: 3_650, default: 90 },
  maxExportRows: { min: 100, max: 500_000, default: 50_000 },
  exportsPerMinute: { min: 1, max: 60, default: 5 },
  readsPerMinute: { min: 10, max: 2_000, default: 240 },
} as const;

/**
 * Values read from `config/plugins.ts`. These are deployment decisions (secrets and abuse
 * limits), so they are not editable from the admin panel: an administrator who could raise the
 * export ceiling from the UI could also use it to pull the whole log out in one go.
 *
 * The runtime-editable settings (retention, what to capture) live in the plugin store; see
 * `services/settings.ts`.
 */
export interface PluginConfig {
  enabled: boolean;
  /**
   * Key for the per-row HMAC signature. Falls back to `admin.auth.secret` when unset, which is
   * fine until that secret is rotated: rows signed under the old key then fail verification.
   */
  signingSecret?: string;
  maxExportRows: number;
  exportsPerMinute: number;
  readsPerMinute: number;
  /** Seed for the runtime settings, applied only when the store has never been written. */
  defaults: Record<string, unknown>;
}

export default {
  default: {
    enabled: true,
    signingSecret: undefined,
    maxExportRows: SETTING_BOUNDS.maxExportRows.default,
    exportsPerMinute: SETTING_BOUNDS.exportsPerMinute.default,
    readsPerMinute: SETTING_BOUNDS.readsPerMinute.default,
    defaults: {},
  } satisfies PluginConfig,

  validator(config: Record<string, unknown>) {
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      throw new Error('plugin config enabled must be a boolean');
    }

    if (config.signingSecret !== undefined && config.signingSecret !== null) {
      if (typeof config.signingSecret !== 'string' || config.signingSecret.length < 32) {
        throw new Error(
          'plugin config signingSecret must be a string of at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
        );
      }
    }

    for (const key of ['maxExportRows', 'exportsPerMinute', 'readsPerMinute'] as const) {
      const raw = config[key];
      if (raw === undefined) continue;

      const bounds = SETTING_BOUNDS[key];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
        throw new Error(`plugin config ${key} must be an integer between ${bounds.min} and ${bounds.max}`);
      }
    }

    const defaults = config.defaults;
    if (defaults !== undefined) {
      if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
        throw new Error('plugin config defaults must be an object');
      }

      const disabled = (defaults as Record<string, unknown>).disabledCategories;
      if (disabled !== undefined) {
        if (
          !Array.isArray(disabled) ||
          disabled.some((value) => !(CATEGORIES as readonly string[]).includes(String(value)))
        ) {
          throw new Error(`plugin config defaults.disabledCategories may only contain: ${CATEGORIES.join(', ')}`);
        }
      }
    }
  },
};
