import { ACTOR_TYPES, CATEGORIES, OUTCOMES } from '../constants';

/**
 * Query-string parsing for every read endpoint.
 *
 * Nothing from the request reaches the query builder unless it passes through here. Each filter
 * has a fixed name, a fixed operator and a value checked against an allow-list or a strict
 * pattern, so a caller cannot pick the column, the operator or smuggle Strapi's `$` filter
 * syntax in (OWASP A03).
 */

export interface LogFilters {
  actorIds?: string[];
  actorTypes?: string[];
  categories?: string[];
  actions?: string[];
  outcomes?: string[];
  targetUid?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const MAX_LIST_VALUES = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9.-]{0,99}$/i;
const UID_PATTERN = /^(api|plugin|admin)::[a-z0-9-]+(\.[a-z0-9-]+)?$/;
const MAX_SEARCH = 100;

export const MAX_PAGE_SIZE = 100;
export const MAX_RANGE_DAYS = 366;

function list(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];

  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  return values
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function single(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return single(raw[0]);
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function checkList(
  name: string,
  raw: unknown,
  accept: (value: string) => boolean
): ParseResult<string[] | undefined> {
  const values = list(raw);
  if (values.length === 0) return { ok: true, value: undefined };
  if (values.length > MAX_LIST_VALUES) {
    return { ok: false, message: `${name} accepts at most ${MAX_LIST_VALUES} values.` };
  }

  const bad = values.find((value) => !accept(value));
  if (bad !== undefined) return { ok: false, message: `${name} contains an unsupported value.` };

  return { ok: true, value: [...new Set(values)] };
}

function parseDate(name: string, raw: unknown): ParseResult<Date | undefined> {
  const value = single(raw);
  if (value === undefined) return { ok: true, value: undefined };

  // Dates only, in ISO form. `Date.parse` alone accepts things like "1" or "March".
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    return { ok: false, message: `${name} must be an ISO 8601 date.` };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false, message: `${name} is not a valid date.` };

  return { ok: true, value: date };
}

const enumOf = (values: readonly string[]) => (value: string) => values.includes(value);

export function parseFilters(query: Record<string, unknown>): ParseResult<LogFilters> {
  const filters: LogFilters = {};

  const checks: Array<[keyof LogFilters, ParseResult<string[] | undefined>]> = [
    ['actorIds', checkList('actor', query.actor, (value) => ID_PATTERN.test(value))],
    ['actorTypes', checkList('actorType', query.actorType, enumOf(ACTOR_TYPES))],
    ['categories', checkList('category', query.category, enumOf(CATEGORIES))],
    ['actions', checkList('action', query.action, (value) => ACTION_PATTERN.test(value))],
    ['outcomes', checkList('outcome', query.outcome, enumOf(OUTCOMES))],
  ];

  for (const [key, result] of checks) {
    if (!result.ok) return result;
    if (result.value) (filters as Record<string, unknown>)[key] = result.value;
  }

  const targetUid = single(query.contentType);
  if (targetUid !== undefined) {
    if (!UID_PATTERN.test(targetUid)) return { ok: false, message: 'contentType is not a valid uid.' };
    filters.targetUid = targetUid;
  }

  const targetId = single(query.targetId);
  if (targetId !== undefined) {
    if (!ID_PATTERN.test(targetId)) return { ok: false, message: 'targetId is not a valid id.' };
    filters.targetId = targetId;
  }

  const from = parseDate('from', query.from);
  if (!from.ok) return from;
  const to = parseDate('to', query.to);
  if (!to.ok) return to;

  if (from.value && to.value && from.value > to.value) {
    return { ok: false, message: 'from must be before to.' };
  }
  filters.from = from.value;
  filters.to = to.value;

  const q = single(query.q);
  if (q !== undefined) {
    if (q.length > MAX_SEARCH) {
      return { ok: false, message: `q must be at most ${MAX_SEARCH} characters.` };
    }
    // Control characters have no business in a search box and only make log lines unreadable.
    if (/[\u0000-\u001f\u007f]/.test(q)) return { ok: false, message: 'q contains control characters.' };
    filters.q = q;
  }

  return { ok: true, value: filters };
}

function positiveInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(single(raw) ?? raw);
  if (!Number.isFinite(value) || value < 1) return fallback;

  return Math.min(Math.floor(value), max);
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  return {
    page: positiveInt(query.page, 1, 100_000),
    pageSize: positiveInt(query.pageSize, 25, MAX_PAGE_SIZE),
  };
}

export function parseSortDirection(query: Record<string, unknown>): 'asc' | 'desc' {
  return single(query.sort) === 'asc' ? 'asc' : 'desc';
}

/** Minutes east of UTC, as `-Date#getTimezoneOffset()` reports it. Used only to bucket days. */
export function parseTzOffset(raw: unknown): number {
  const value = Number(single(raw) ?? 0);
  if (!Number.isInteger(value) || Math.abs(value) > 14 * 60) return 0;
  return value;
}

/** Translates validated filters into a Strapi query-engine `where`. Values are bound, never inlined. */
export function toWhere(filters: LogFilters): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];

  if (filters.actorIds) and.push({ actorId: { $in: filters.actorIds } });
  if (filters.actorTypes) and.push({ actorType: { $in: filters.actorTypes } });
  if (filters.categories) and.push({ category: { $in: filters.categories } });
  if (filters.actions) and.push({ action: { $in: filters.actions } });
  if (filters.outcomes) and.push({ outcome: { $in: filters.outcomes } });
  if (filters.targetUid) and.push({ targetUid: filters.targetUid });
  if (filters.targetId) and.push({ targetId: filters.targetId });
  if (filters.from) and.push({ occurredAt: { $gte: filters.from.toISOString() } });
  if (filters.to) and.push({ occurredAt: { $lte: filters.to.toISOString() } });

  if (filters.q) {
    and.push({
      $or: [
        { actorEmail: { $containsi: filters.q } },
        { actorName: { $containsi: filters.q } },
        { targetLabel: { $containsi: filters.q } },
        { targetId: { $containsi: filters.q } },
        { action: { $containsi: filters.q } },
        { ipAddress: { $containsi: filters.q } },
      ],
    });
  }

  return and.length > 0 ? { $and: and } : {};
}

/** A JSON-safe echo of the filters, for the export's own audit entry. */
export function describeFilters(filters: LogFilters): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    output[key] = value instanceof Date ? value.toISOString() : value;
  }
  return output;
}
