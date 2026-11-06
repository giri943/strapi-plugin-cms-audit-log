import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';
import pluginPermissions from './permissions';
import { PLUGIN_ID } from './pluginId';
import { getTranslation } from './utils/getTranslation';

export default {
  register(app: any) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: PluginIcon,
      intlLabel: { id: getTranslation('plugin.name'), defaultMessage: 'Audit Log' },
      permissions: pluginPermissions.readLogs,
      // Not async: Strapi wants a plain loader returning a dynamic import with a `default`.
      Component: () => import('./pages/App').then((mod) => ({ default: mod.App })),
    });

    app.addSettingsLink(
      {
        id: PLUGIN_ID,
        intlLabel: { id: getTranslation('settings.section'), defaultMessage: 'Audit Log' },
      },
      {
        id: `${PLUGIN_ID}-configuration`,
        to: `${PLUGIN_ID}/configuration`,
        intlLabel: { id: getTranslation('settings.title'), defaultMessage: 'Configuration' },
        permissions: pluginPermissions.readSettings,
        Component: () => import('./pages/SettingsPage').then((mod) => ({ default: mod.SettingsPage })),
      }
    );

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });
  },

  async registerTrads({ locales }: { locales: string[] }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};
