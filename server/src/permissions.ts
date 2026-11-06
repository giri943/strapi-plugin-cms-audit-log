import { PLUGIN_NAME } from './constants';

/**
 * Admin RBAC action ids.
 *
 * Strapi requires uids to match `/^[a-z]([a-z|.|-]+)[a-z]$/`, and the admin panel's `useRBAC`
 * names each flag after the last dot-separated segment only (`read-logs` → `canReadLogs`). Each
 * uid is therefore a single hyphenated segment, unique on its own.
 */
export const PLUGIN_ACTIONS = {
  readLogs: `plugin::${PLUGIN_NAME}.read-logs`,
  exportLogs: `plugin::${PLUGIN_NAME}.export-logs`,
  readSettings: `plugin::${PLUGIN_NAME}.read-settings`,
  updateSettings: `plugin::${PLUGIN_NAME}.update-settings`,
} as const;

const SUB_CATEGORY = 'audit-log';

export const permissionActionDefinitions = [
  {
    uid: 'read-logs',
    displayName: 'View audit logs and the activity dashboard',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: SUB_CATEGORY,
  },
  {
    uid: 'export-logs',
    displayName: 'Export audit logs to CSV',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: SUB_CATEGORY,
  },
  {
    uid: 'read-settings',
    displayName: 'View audit log settings',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: SUB_CATEGORY,
  },
  {
    uid: 'update-settings',
    displayName: 'Change what is recorded and how long it is kept',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: SUB_CATEGORY,
  },
];
