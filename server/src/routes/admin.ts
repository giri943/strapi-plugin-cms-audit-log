import { PLUGIN_NAME } from '../constants';
import { PLUGIN_ACTIONS } from '../permissions';

/**
 * Every route is admin-only and checks a plugin permission on the server (OWASP A01). The
 * admin panel also hides controls the user lacks, but that is a courtesy; these policies are
 * what still applies when the endpoint is called directly.
 *
 * Fixed paths come before `/logs/:id` so the router never reads "export" as an id.
 */
const guard = (action: string, bucket: 'read' | 'export' = 'read') => [
  'admin::isAuthenticatedAdmin',
  { name: 'admin::hasPermissions', config: { actions: [action] } },
  { name: `plugin::${PLUGIN_NAME}.rate-limit`, config: { bucket } },
];

export default {
  type: 'admin' as const,
  routes: [
    {
      method: 'GET' as const,
      path: '/logs',
      handler: 'logs.list',
      config: { policies: guard(PLUGIN_ACTIONS.readLogs) },
    },
    {
      method: 'GET' as const,
      path: '/logs/stats',
      handler: 'logs.stats',
      config: { policies: guard(PLUGIN_ACTIONS.readLogs) },
    },
    {
      method: 'GET' as const,
      path: '/logs/options',
      handler: 'logs.options',
      config: { policies: guard(PLUGIN_ACTIONS.readLogs) },
    },
    {
      method: 'GET' as const,
      path: '/logs/export',
      handler: 'logs.export',
      config: { policies: guard(PLUGIN_ACTIONS.exportLogs, 'export') },
    },
    {
      method: 'GET' as const,
      path: '/logs/verify',
      handler: 'logs.verify',
      // A full verification reads as much as an export does, so it shares the export budget.
      config: { policies: guard(PLUGIN_ACTIONS.readLogs, 'export') },
    },
    {
      method: 'GET' as const,
      path: '/logs/:id',
      handler: 'logs.findOne',
      config: { policies: guard(PLUGIN_ACTIONS.readLogs) },
    },
    {
      method: 'GET' as const,
      path: '/settings',
      handler: 'settings.get',
      config: { policies: guard(PLUGIN_ACTIONS.readSettings) },
    },
    {
      method: 'PUT' as const,
      path: '/settings',
      handler: 'settings.update',
      config: { policies: guard(PLUGIN_ACTIONS.updateSettings) },
    },
  ],
};
