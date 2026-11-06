import { stableStringify } from './diff';
import type { ChangeOp, FieldChange } from './types';

/**
 * Field-by-field diff of two flat snapshots, for records that are not content: media files and
 * folders, API and transfer tokens, webhooks.
 *
 * - `list` fields (events, permissions, header names) report the items added and removed, so
 *   unticking one event out of twelve reads as that one event.
 * - `secret` fields (header values) report that they changed and nothing else. The snapshot holds
 *   a fingerprint for comparison; no value reaches the log.
 */
export interface FieldSpec {
  key: string;
  label: string;
  list?: boolean;
  secret?: boolean;
}

type Snapshot = Record<string, unknown>;

const isBlank = (value: unknown) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function diffRecord(fields: readonly FieldSpec[], before: Snapshot | null, after: Snapshot | null): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const spec of fields) {
    const left = before?.[spec.key] ?? null;
    const right = after?.[spec.key] ?? null;
    if (isBlank(left) && isBlank(right)) continue;
    if (stableStringify(left) === stableStringify(right)) continue;

    const base = { field: spec.key, path: [spec.label] };

    if (spec.secret) {
      const op: ChangeOp = isBlank(left) ? 'added' : isBlank(right) ? 'removed' : 'changed';
      changes.push({ ...base, op, kind: 'redacted' });
      continue;
    }

    if (spec.list && before && after) {
      const was = asList(left);
      const now = asList(right);
      const removed = was.filter((item) => !now.includes(item));
      const added = now.filter((item) => !was.includes(item));
      if (removed.length > 0) changes.push({ ...base, op: 'removed', kind: 'value', before: removed, after: null });
      if (added.length > 0) changes.push({ ...base, op: 'added', kind: 'value', before: null, after: added });
      continue;
    }

    const op: ChangeOp = isBlank(left) ? 'added' : isBlank(right) ? 'removed' : 'changed';
    changes.push({ ...base, op, kind: 'value', before: left, after: right });
  }

  return changes;
}

/**
 * A URL with its query string values hidden. Webhook URLs often carry a token
 * (`?token=…`, `?sig=…`), and the log must not become the place it leaks from.
 */
export function maskUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? '•••' : '';
      url.password = url.password ? '•••' : '';
    }
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '•••');
    return url.toString().replace(/%E2%80%A2/g, '•');
  } catch {
    return value.replace(/\?.*$/, '?•••');
  }
}

/** "7 days", "30 days", "Unlimited": how the admin panel describes a token duration. */
export function durationLabel(lifespan: unknown): string {
  const ms = Number(lifespan);
  if (lifespan === null || lifespan === undefined || !Number.isFinite(ms) || ms <= 0) return 'Unlimited';
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? '1 day' : `${days} days`;
}
