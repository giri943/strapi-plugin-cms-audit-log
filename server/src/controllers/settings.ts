import { strapiErrors } from '../utils/strapi-errors';
import type { Core } from '@strapi/strapi';
import { SETTING_BOUNDS, type PluginConfig } from '../config';
import { CATEGORIES, IGNORED_CONTENT_TYPES, PLUGIN_NAME } from '../constants';
import { LOCKED_CATEGORIES, type PluginSettings } from '../services/settings';
import type { RequestContext } from '../types';

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const errors = strapiErrors(strapi);
  const plugin = () => strapi.plugin(PLUGIN_NAME);

  function contentTypeChoices() {
    return Object.entries(strapi.contentTypes as unknown as Record<string, { info?: { displayName?: string }; uid?: string }>)
      .filter(([uid]) => !IGNORED_CONTENT_TYPES.includes(uid))
      .filter(([uid]) => uid.startsWith('api::') || uid.startsWith('plugin::'))
      .map(([uid, model]) => ({ uid, label: model.info?.displayName ?? uid }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async function describe() {
    const settings = (await plugin().service('settings').get()) as PluginSettings;
    const config = (strapi.config.get(`plugin::${PLUGIN_NAME}`) ?? {}) as Partial<PluginConfig>;

    return {
      settings,
      options: {
        categories: [...CATEGORIES],
        lockedCategories: [...LOCKED_CATEGORIES],
        contentTypes: contentTypeChoices(),
        retentionDays: SETTING_BOUNDS.retentionDays,
      },
      // Read-only: these come from config/plugins and are shown so an administrator can tell
      // why the panel behaves as it does, without being able to change them here.
      deployment: {
        enabled: config.enabled !== false,
        signingKey: plugin().service('writer').keySource(),
        maxExportRows: config.maxExportRows,
        exportsPerMinute: config.exportsPerMinute,
        readsPerMinute: config.readsPerMinute,
      },
    };
  }

  return {
    async get(ctx: RequestContext) {
      ctx.set('Cache-Control', 'no-store');
      ctx.body = await describe();
    },

    async update(ctx: RequestContext) {
      const result = await plugin().service('settings').update(ctx.request.body);
      if (!result.ok) {
        throw new errors.ValidationError(result.message, { field: result.field });
      }

      if (result.changes.length > 0) {
        await plugin().service('capture').recordAudit('audit.settings.update', { changes: result.changes });
      }

      ctx.body = await describe();
    },
  };
};
