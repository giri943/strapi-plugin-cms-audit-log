import type { ChangeOp, FieldChange } from './types';
import { stableStringify } from './diff';

/*
 * Before/after diffs for the admin panel's own records: admin users, roles and role
 * permissions. Strapi's event hub only says what these look like after a change, so the
 * capture service snapshots them before the write and hands both sides to these functions.
 */

type Row = Record<string, unknown>;

const asRow = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;

/** Admin user columns worth showing, with the label the admin panel uses for them. */
export const ADMIN_USER_FIELDS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['firstname', 'First name'],
  ['lastname', 'Last name'],
  ['email', 'Email'],
  ['username', 'Username'],
  ['isActive', 'Active'],
  ['blocked', 'Blocked'],
  ['preferedLanguage', 'Interface language'],
  ['roles', 'Roles'],
];

/** Keys in an update's data that are an editor's change rather than Strapi bookkeeping. */
export const ADMIN_USER_TRACKED = new Set([...ADMIN_USER_FIELDS.map(([key]) => key), 'password']);

/** Columns to read for a snapshot. Never the password, tokens or anything else secret. */
export const ADMIN_USER_SELECT = ['id', 'firstname', 'lastname', 'email', 'username', 'isActive', 'blocked', 'preferedLanguage'];

export const ROLE_FIELDS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['name', 'Name'],
  ['description', 'Description'],
];

function roleNames(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => {
      const record = asRow(role);
      if (!record) return String(role);
      return typeof record.name === 'string' ? record.name : `Role #${String(record.id)}`;
    })
    .sort((a, b) => a.localeCompare(b));
}

/** A user row reduced to what the log shows: plain values, roles as a sorted list of names. */
export function adminUserSnapshot(user: unknown): Row | null {
  const record = asRow(user);
  if (!record) return null;

  const snapshot: Row = {};
  for (const [key] of ADMIN_USER_FIELDS) {
    if (key === 'roles') snapshot.roles = roleNames(record.roles);
    else snapshot[key] = record[key] ?? null;
  }
  return snapshot;
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

function compare(
  fields: ReadonlyArray<readonly [string, string]>,
  before: Row | null,
  after: Row | null
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, label] of fields) {
    const left = before?.[key] ?? null;
    const right = after?.[key] ?? null;
    if (isBlank(left) && isBlank(right)) continue;
    if (stableStringify(left) === stableStringify(right)) continue;

    const op: ChangeOp = isBlank(left) ? 'added' : isBlank(right) ? 'removed' : 'changed';
    changes.push({ field: key, path: [label], op, kind: 'value', before: left, after: right });
  }
  return changes;
}

/**
 * What an admin user update changed. `data` is what the update wrote: a password in it is
 * reported as changed, never with a value.
 */
export function diffAdminUser(before: unknown, after: unknown, data?: Row): FieldChange[] {
  const changes = compare(ADMIN_USER_FIELDS, adminUserSnapshot(before), adminUserSnapshot(after));
  if (data && typeof data.password === 'string' && data.password.length > 0) {
    changes.push({ field: 'password', path: ['Password'], op: 'changed', kind: 'redacted' });
  }
  return changes;
}

/** An admin user's details as one-sided changes, for an invite (added) or a delete (removed). */
export function adminUserFields(user: unknown, op: 'added' | 'removed'): FieldChange[] {
  const snapshot = adminUserSnapshot(user);
  return op === 'added' ? compare(ADMIN_USER_FIELDS, null, snapshot) : compare(ADMIN_USER_FIELDS, snapshot, null);
}

export function diffRole(before: unknown, after: unknown): FieldChange[] {
  const pick = (role: unknown) => {
    const record = asRow(role);
    return record ? { name: record.name ?? null, description: record.description ?? null } : null;
  };
  return compare(ROLE_FIELDS, pick(before), pick(after));
}

// --- Permissions ------------------------------------------------------------------------------

export interface PermissionRow {
  action: string;
  subject?: string | null;
  properties?: Record<string, unknown> | null;
  conditions?: unknown[] | null;
}

export interface PermissionLabels {
  /** Where the permission sits, as the Roles screen groups it: "Article", "Settings › Media Library". */
  group(action: string, subject: string | null): string;
  /** The action as the Roles screen names it: "Create", "Publish", "Access the Media Library". */
  action(action: string): string;
  condition(id: string): string;
}

const PROPERTY_LABELS: Record<string, string> = { fields: 'Fields', locales: 'Locales' };

const keyOf = (permission: PermissionRow) => `${permission.action}\u0000${permission.subject ?? ''}`;

function sortedStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(String).sort((a, b) => a.localeCompare(b));
}

/** The parts of a permission that narrow it: fields, locales and conditions, in words. */
function scope(permission: PermissionRow, labels: PermissionLabels): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(permission.properties ?? {})) {
    const list = sortedStrings(value);
    if (list) out[PROPERTY_LABELS[key] ?? key] = list;
  }
  const conditions = sortedStrings(permission.conditions);
  if (conditions && conditions.length > 0) out.Conditions = conditions.map((id) => labels.condition(id));
  return out;
}

const summary = (permission: PermissionRow, labels: PermissionLabels): unknown => {
  const narrowed = scope(permission, labels);
  return Object.keys(narrowed).length > 0 ? narrowed : 'Allowed';
};

/**
 * What a role's permission save granted, revoked and narrowed.
 *
 * Strapi stores one row per action and subject, and replaces a row (delete, then create) when
 * its fields or conditions change. Rows are matched on action and subject here, so a field
 * being unticked reads as that, not as a permission revoked and granted again.
 */
export function diffPermissions(
  before: readonly PermissionRow[],
  after: readonly PermissionRow[],
  labels: PermissionLabels
): FieldChange[] {
  const old = new Map(before.map((permission) => [keyOf(permission), permission]));
  const now = new Map(after.map((permission) => [keyOf(permission), permission]));
  const changes: Array<FieldChange & { sortKey: string }> = [];

  const location = (permission: PermissionRow) => {
    const group = labels.group(permission.action, permission.subject ?? null);
    const action = labels.action(permission.action);
    return {
      group,
      action,
      field: `permissions.${permission.action}${permission.subject ? `.${permission.subject}` : ''}`,
    };
  };

  for (const [key, permission] of now) {
    const where = location(permission);
    const previous = old.get(key);
    if (!previous) {
      changes.push({
        sortKey: `${where.group}\u0000${where.action}`,
        field: where.field,
        path: [where.group, where.action],
        op: 'added',
        kind: 'value',
        before: null,
        after: summary(permission, labels),
      });
      continue;
    }

    const left = scope(previous, labels);
    const right = scope(permission, labels);
    for (const part of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (stableStringify(left[part] ?? null) === stableStringify(right[part] ?? null)) continue;
      const sortKey = `${where.group}\u0000${where.action}\u0000${part}`;
      const field = `${where.field}.${part.toLowerCase()}`;
      const path = [where.group, where.action, part];
      const was = left[part] as string[] | undefined;
      const now = right[part] as string[] | undefined;

      // Fields and locales: a missing list means "all of them"; conditions: "none". Going to or
      // from that is shown whole. Otherwise only the items ticked or unticked are listed, so
      // removing one field from a list of twenty reads as that one field.
      if ((!was || !now) && part !== 'Conditions') {
        changes.push({ sortKey, field, path, op: 'changed', kind: 'value', before: was ?? 'All', after: now ?? 'All' });
        continue;
      }
      const removed = (was ?? []).filter((item) => !(now ?? []).includes(item));
      const added = (now ?? []).filter((item) => !(was ?? []).includes(item));
      if (removed.length > 0) {
        changes.push({ sortKey: `${sortKey}\u00001`, field, path, op: 'removed', kind: 'value', before: removed, after: null });
      }
      if (added.length > 0) {
        changes.push({ sortKey: `${sortKey}\u00002`, field, path, op: 'added', kind: 'value', before: null, after: added });
      }
    }
  }

  for (const [key, permission] of old) {
    if (now.has(key)) continue;
    const where = location(permission);
    changes.push({
      sortKey: `${where.group}\u0000${where.action}`,
      field: where.field,
      path: [where.group, where.action],
      op: 'removed',
      kind: 'value',
      before: summary(permission, labels),
      after: null,
    });
  }

  return changes
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _sortKey, ...change }) => change);
}
