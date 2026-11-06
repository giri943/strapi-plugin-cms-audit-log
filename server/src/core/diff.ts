import { LIMITS } from '../constants';
import { redactValue, type SensitiveKeyMatcher } from './redact';
import type { FieldChange } from './types';

/** Columns Strapi manages itself. A change to them is never what the editor did. */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
]);

export interface AttributeInfo {
  type: string;
  [key: string]: unknown;
}

export interface DiffInput {
  mode: 'create' | 'update';
  /** The `data` the caller passed. Only these fields are considered. */
  data: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  attributes: Record<string, AttributeInfo>;
  isSensitive: SensitiveKeyMatcher;
}

/** Component ids and editor scratch keys change on every save without meaning anything. */
const VOLATILE_KEYS = new Set(['id', '__temp_key__', '__component_id']);

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalise = (current: unknown): unknown => {
    if (current === undefined) return null;
    if (current instanceof Date) return current.toISOString();
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[circular]';
    seen.add(current);

    if (Array.isArray(current)) return current.map(normalise);

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      sorted[key] = normalise((current as Record<string, unknown>)[key]);
    }
    return sorted;
  };

  return JSON.stringify(normalise(value));
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(key)) continue;
    output[key] = stripVolatile(child);
  }
  return output;
}

/** A media field is identified by the file ids it points at, whatever else was populated. */
function mediaIds(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(mediaIds);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return record.id ?? record.documentId ?? null;
  }
  return value;
}

function comparable(type: string, value: unknown): unknown {
  if (type === 'media') return mediaIds(value);
  if (type === 'component' || type === 'dynamiczone') return stripVolatile(value);
  if (value === undefined) return null;
  return value;
}

const MAX_RELATION_IDS = 20;

function relationIds(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];

  return list.slice(0, MAX_RELATION_IDS).map((item) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return record.documentId ?? record.id ?? null;
    }
    return item;
  });
}

/**
 * Describes a relation write without loading the related entries.
 *
 * The Content Manager sends `{ connect, disconnect }`; the API also accepts `set`, a bare array
 * or a single id. An empty connect/disconnect pair is what the editor sends when the relation
 * was not touched, and is not a change.
 */
export function summariseRelationWrite(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (value === null) return { set: [] };

  if (Array.isArray(value)) return { set: relationIds(value), count: value.length };

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    for (const key of ['connect', 'disconnect', 'set'] as const) {
      const list = record[key];
      if (Array.isArray(list) && (list.length > 0 || key === 'set')) {
        summary[key] = relationIds(list);
        summary[`${key}Count`] = list.length;
      }
    }

    return Object.keys(summary).length > 0 ? summary : null;
  }

  return { set: [value] };
}

/**
 * Lists what an update or create actually changed.
 *
 * The Content Manager sends the whole form on every save, so a field being present in `data`
 * says nothing about whether it changed. Each one is compared against the stored state, and
 * only real differences are kept.
 */
export function diffDocument(input: DiffInput): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of Object.keys(input.data)) {
    if (changes.length >= LIMITS.maxChangesPerEntry) break;
    if (SYSTEM_FIELDS.has(field)) continue;

    const attribute = input.attributes[field];
    if (!attribute) continue;

    const incoming = input.data[field];

    if (attribute.type === 'password' || input.isSensitive(field)) {
      if (incoming === undefined || incoming === null || incoming === '') continue;
      changes.push({ field, kind: 'redacted' });
      continue;
    }

    if (attribute.type === 'relation') {
      const summary = summariseRelationWrite(incoming);
      if (summary) changes.push({ field, kind: 'reference', after: summary });
      continue;
    }

    const beforeValue = input.mode === 'create' ? null : input.before?.[field];
    const afterValue =
      input.after && Object.prototype.hasOwnProperty.call(input.after, field)
        ? input.after[field]
        : incoming;

    const left = comparable(attribute.type, beforeValue);
    const right = comparable(attribute.type, afterValue);

    if (stableStringify(left) === stableStringify(right)) continue;
    if (input.mode === 'create' && (right === null || right === '')) continue;

    changes.push({
      field,
      kind: 'value',
      before: redactValue(left, input.isSensitive),
      after: redactValue(right, input.isSensitive),
    });
  }

  return changes;
}
