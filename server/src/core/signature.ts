import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from './diff';
import type { AuditRow } from './types';

export const SIGNATURE_VERSION = 'v1';

/**
 * The fields covered by the signature, in a fixed order.
 *
 * `id` is left out because the database assigns it after the row is signed. Changing any of
 * these, including moving `occurredAt`, makes verification fail.
 */
const SIGNED_FIELDS = [
  'action',
  'category',
  'outcome',
  'actorType',
  'actorId',
  'actorEmail',
  'actorName',
  'targetUid',
  'targetId',
  'targetLabel',
  'localeCode',
  'changes',
  'details',
  'ipAddress',
  'userAgent',
  'requestMethod',
  'requestPath',
  'occurredAt',
] as const satisfies ReadonlyArray<keyof AuditRow>;

/**
 * Timestamps are signed at whole-second precision. MySQL `datetime` columns drop milliseconds
 * and some drivers hand dates back as strings, so the exact value written is not always the one
 * read back.
 */
function canonicalTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return 'invalid';

  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

/**
 * JSON columns can come back as strings (MySQL without JSON parsing, some SQLite builds), and
 * `jsonb` reorders keys. Parsing and then serialising with sorted keys makes both forms agree.
 */
function canonicalJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? null;
}

export function canonicalize(row: Partial<AuditRow>): string {
  const parts: Record<string, unknown> = {};

  for (const field of SIGNED_FIELDS) {
    const value = row[field];

    if (field === 'occurredAt') parts[field] = canonicalTime(value);
    else if (field === 'changes' || field === 'details') parts[field] = canonicalJson(value);
    else parts[field] = value === undefined || value === '' ? null : value;
  }

  return stableStringify(parts);
}

/**
 * The signing key is derived from the configured secret rather than being the secret itself,
 * so a leaked audit key cannot be used to forge admin sessions when the fallback secret is
 * `admin.auth.secret`.
 */
export function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('cms-audit-log:signing-key:v1').digest();
}

export function signRow(row: Partial<AuditRow>, key: Buffer): string {
  const mac = createHmac('sha256', key).update(canonicalize(row)).digest('hex');
  return `${SIGNATURE_VERSION}.${mac}`;
}

/** `unverifiable`: the row is signed but no key is configured on this server to check it. */
export type Integrity = 'valid' | 'invalid' | 'unsigned' | 'unverifiable';

export function verifyRow(row: Partial<AuditRow>, key: Buffer): Integrity {
  const stored = row.signature;
  if (!stored) return 'unsigned';

  const expected = signRow(row, key);
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}
