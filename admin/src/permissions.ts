import { PLUGIN_ID } from './pluginId';

/**
 * Mirrors `server/src/permissions.ts`. The panel uses these to hide controls; the server
 * re-checks every one, so a stale copy here can only hide a button, never grant access.
 */
const pluginPermissions = {
  readLogs: [{ action: `plugin::${PLUGIN_ID}.read-logs`, subject: null }],
  exportLogs: [{ action: `plugin::${PLUGIN_ID}.export-logs`, subject: null }],
  readSettings: [{ action: `plugin::${PLUGIN_ID}.read-settings`, subject: null }],
  updateSettings: [{ action: `plugin::${PLUGIN_ID}.update-settings`, subject: null }],
};

/** `useRBAC` names each flag after the last segment of the action id, not after these keys. */
export const RBAC_FLAGS = {
  readLogs: 'canReadLogs',
  exportLogs: 'canExportLogs',
  readSettings: 'canReadSettings',
  updateSettings: 'canUpdateSettings',
} as const;

export type AllowedActions = Partial<Record<(typeof RBAC_FLAGS)[keyof typeof RBAC_FLAGS], boolean>>;

export default pluginPermissions;
