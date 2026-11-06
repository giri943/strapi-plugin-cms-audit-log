import { ALWAYS_REDACTED_PATTERNS, LIMITS, REDACTED } from '../constants';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** A string column value: trimmed to the column width, empty becomes null. */
export function columnString(value: unknown, max = 255): string | null {
  if (value === undefined || value === null) return null;

  const text = String(value);
  if (text.length === 0) return null;

  return text.length <= max ? text : text.slice(0, max);
}

export function createSensitiveKeyMatcher(extraFields: readonly string[] = []) {
  const extra = new Set(extraFields.map((field) => field.toLowerCase()));

  return (key: string): boolean => {
    const lower = key.toLowerCase();
    if (extra.has(lower)) return true;

    return ALWAYS_REDACTED_PATTERNS.some((pattern) => pattern.test(key));
  };
}

export type SensitiveKeyMatcher = ReturnType<typeof createSensitiveKeyMatcher>;

/**
 * Deep copy that is safe to store and to show to an auditor.
 *
 * - Values under sensitive keys become `[REDACTED]`, at any depth.
 * - Long strings, wide objects and long arrays are cut down, so one entry cannot fill the table.
 * - Functions, symbols, buffers and cycles are dropped rather than serialised.
 */
export function redactValue(value: unknown, isSensitive: SensitiveKeyMatcher): unknown {
  const seen = new WeakSet<object>();

  const walk = (current: unknown, depth: number): unknown => {
    if (current === null || current === undefined) return null;

    if (typeof current === 'string') return truncate(current, LIMITS.maxValueChars);
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'boolean') return current;
    if (typeof current === 'bigint') return current.toString();
    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? null : current.toISOString();
    }
    if (typeof current !== 'object') return null;
    if (Buffer.isBuffer(current)) return `[binary ${current.length} bytes]`;

    if (seen.has(current)) return '[circular]';
    if (depth >= MAX_DEPTH) return '[nested]';
    seen.add(current);

    if (Array.isArray(current)) {
      const items = current.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1));
      if (current.length > MAX_ARRAY_ITEMS) items.push(`[+${current.length - MAX_ARRAY_ITEMS} more]`);
      return items;
    }

    const output: Record<string, unknown> = {};
    const keys = Object.keys(current);

    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      const child = (current as Record<string, unknown>)[key];
      if (typeof child === 'function' || typeof child === 'symbol') continue;

      output[key] = isSensitive(key) ? REDACTED : walk(child, depth + 1);
    }
    if (keys.length > MAX_OBJECT_KEYS) output['…'] = `[+${keys.length - MAX_OBJECT_KEYS} more keys]`;

    return output;
  };

  return walk(value, 0);
}

/** Redacts a details object and caps its serialised size. */
export function boundedDetails(
  details: Record<string, unknown> | undefined,
  isSensitive: SensitiveKeyMatcher
): Record<string, unknown> | null {
  if (!details) return null;

  const clean = redactValue(details, isSensitive) as Record<string, unknown>;
  const size = Buffer.byteLength(JSON.stringify(clean), 'utf8');
  if (size <= LIMITS.maxDetailsBytes) return clean;

  return { truncated: true, originalBytes: size, keys: Object.keys(clean).slice(0, 50) };
}
