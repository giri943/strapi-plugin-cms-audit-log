import type { ActorType, Category, LogListItem } from './api';

export const CATEGORY_LABELS: Record<Category, string> = {
  content: 'Content',
  media: 'Media',
  auth: 'Sign-in',
  'admin-user': 'Admin users',
  role: 'Roles & permissions',
  schema: 'Content types',
  audit: 'Audit log',
};

export const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
  admin: 'Admin',
  'api-token': 'API token',
  'end-user': 'End user',
  system: 'System',
  anonymous: 'Anonymous',
};

const ACTION_LABELS: Record<string, string> = {
  'entry.create': 'Created',
  'entry.update': 'Updated',
  'entry.delete': 'Deleted',
  'entry.publish': 'Published',
  'entry.unpublish': 'Unpublished',
  'entry.discard-draft': 'Discarded draft',
  'entry.clone': 'Duplicated',
  'media.create': 'Uploaded file',
  'media.update': 'Updated file',
  'media.delete': 'Deleted file',
  'media-folder.create': 'Created folder',
  'media-folder.update': 'Updated folder',
  'media-folder.delete': 'Deleted folder',
  'admin.login': 'Signed in',
  'admin.logout': 'Signed out',
  'admin.login.failed': 'Failed sign-in',
  'admin.login.rate-limited': 'Sign-in blocked (too many attempts)',
  'admin-user.create': 'Created admin user',
  'admin-user.update': 'Updated admin user',
  'admin-user.delete': 'Deleted admin user',
  'role.create': 'Created role',
  'role.update': 'Updated role',
  'role.delete': 'Deleted role',
  'permission.create': 'Granted permissions',
  'permission.update': 'Changed permissions',
  'permission.delete': 'Removed permissions',
  'role.permissions.update': 'Changed role permissions',
  'content-type.create': 'Created content type',
  'content-type.update': 'Changed content type',
  'content-type.delete': 'Deleted content type',
  'component.create': 'Created component',
  'component.update': 'Changed component',
  'component.delete': 'Deleted component',
  'audit.export': 'Exported audit log',
  'audit.verify': 'Checked log integrity',
  'audit.settings.update': 'Changed audit settings',
  'audit.retention.prune': 'Removed expired entries',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function actorLabel(row: Pick<LogListItem, 'actorType' | 'actorName' | 'actorEmail' | 'actorId'>): string {
  if (row.actorType === 'system') return 'System';
  if (row.actorType === 'anonymous') return 'Anonymous';
  return row.actorName || row.actorEmail || `${ACTOR_TYPE_LABELS[row.actorType]} #${row.actorId ?? '?'}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatRelative(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '';

  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** Renders a stored value for the diff view. Objects are shown as compact JSON. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return '—';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}
