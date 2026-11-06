import type { LogQuery } from './api';

export type RangeKey = '24h' | '7d' | '30d' | '90d' | 'custom';

export const RANGE_LABELS: Record<RangeKey, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  custom: 'Custom range',
};

const RANGE_DAYS: Record<Exclude<RangeKey, 'custom'>, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export interface DashboardFilters {
  range: RangeKey;
  /** `yyyy-mm-dd`, local time. Only used when `range` is `custom`. */
  from?: string;
  to?: string;
  /** `type:id`, because an admin and an end user can share a numeric id. */
  actor?: string;
  category?: string;
  outcome?: string;
  contentType?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: DashboardFilters = { range: '7d', page: 1, pageSize: 25 };

const KEYS = ['range', 'from', 'to', 'actor', 'category', 'outcome', 'contentType', 'q', 'page', 'pageSize'] as const;

export function readFilters(params: URLSearchParams): DashboardFilters {
  const range = params.get('range') as RangeKey | null;
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));

  return {
    range: range && range in RANGE_LABELS ? range : DEFAULT_FILTERS.range,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    actor: params.get('actor') ?? undefined,
    category: params.get('category') ?? undefined,
    outcome: params.get('outcome') ?? undefined,
    contentType: params.get('contentType') ?? undefined,
    q: params.get('q') ?? undefined,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_FILTERS.pageSize,
  };
}

export function writeFilters(filters: DashboardFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = filters[key];
    if (value === undefined || value === '' || value === DEFAULT_FILTERS[key as keyof DashboardFilters]) continue;
    params.set(key, String(value));
  }
  return params;
}

function startOfLocalDay(value: string): Date | undefined {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function endOfLocalDay(value: string): Date | undefined {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export function resolveRange(filters: DashboardFilters, now = new Date()): { from?: Date; to?: Date } {
  if (filters.range === 'custom') {
    return {
      from: filters.from ? startOfLocalDay(filters.from) : undefined,
      to: filters.to ? endOfLocalDay(filters.to) : undefined,
    };
  }

  const days = RANGE_DAYS[filters.range];
  if (filters.range === '24h') return { from: new Date(now.getTime() - 86_400_000), to: now };

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from, to: now };
}

/** The server query for these filters, without paging. */
export function toQuery(filters: DashboardFilters, now = new Date()): LogQuery {
  const { from, to } = resolveRange(filters, now);
  const [actorType, ...idParts] = (filters.actor ?? '').split(':');
  const actorId = idParts.join(':');

  return {
    from: from?.toISOString(),
    to: to?.toISOString(),
    actor: actorId || undefined,
    actorType: actorId ? actorType : undefined,
    category: filters.category,
    outcome: filters.outcome,
    contentType: filters.contentType,
    q: filters.q?.trim() || undefined,
    tz: -now.getTimezoneOffset(),
  };
}

export function activeFilterCount(filters: DashboardFilters): number {
  return [filters.actor, filters.category, filters.outcome, filters.contentType, filters.q].filter(Boolean).length;
}
