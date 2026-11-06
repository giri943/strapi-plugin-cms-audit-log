import type { Core } from '@strapi/strapi';
import { AUDIT_LOG_TABLE, AUDIT_LOG_UID, CATEGORIES, PLUGIN_NAME } from '../constants';
import { toWhere, type LogFilters } from '../core/filters';
import type { Integrity } from '../core/signature';
import type { AuditRow } from '../core/types';

export interface StatsResult {
  from: string;
  to: string;
  total: number;
  sampled: boolean;
  failures: number;
  failedLogins: number;
  activeActors: number;
  byCategory: Record<string, number>;
  perDay: Array<{ date: string; count: number; failures: number }>;
  topActors: Array<{ id: string; label: string; type: string; count: number }>;
  topContentTypes: Array<{ uid: string; label: string; count: number }>;
}

const EXPORT_PAGE = 500;
const STATS_SAMPLE_LIMIT = 100_000;
const DAY_MS = 86_400_000;

/** A list row: the heavy JSON columns are left out until someone opens the entry. */
const LIST_FIELDS = [
  'id',
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
  'ipAddress',
  'occurredAt',
];

function localDay(date: Date, tzOffsetMinutes: number): string {
  return new Date(date.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const query = () => strapi.db.query(AUDIT_LOG_UID);
  const writer = () => strapi.plugin(PLUGIN_NAME).service('writer');

  /** Physical column names, read from Strapi's metadata rather than guessed. */
  function column(attribute: string): string {
    const meta = strapi.db.metadata.get(AUDIT_LOG_UID) as unknown as {
      attributes: Record<string, { columnName?: string }>;
    };
    return meta.attributes[attribute]?.columnName ?? attribute;
  }

  function contentTypeLabel(uid: string): string {
    const model = strapi.getModel(uid as never) as { info?: { displayName?: string } } | undefined;
    return model?.info?.displayName ?? uid;
  }

  return {
    async list(filters: LogFilters, page: number, pageSize: number, sort: 'asc' | 'desc') {
      const where = toWhere(filters);
      const [results, total] = await Promise.all([
        query().findMany({
          select: LIST_FIELDS,
          where,
          orderBy: [{ occurredAt: sort }, { id: sort }],
          offset: (page - 1) * pageSize,
          limit: pageSize,
        }),
        query().count({ where }),
      ]);

      return {
        results,
        pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
      };
    },

    async findOne(id: number): Promise<(AuditRow & { integrity: Integrity }) | null> {
      const row = (await query().findOne({ where: { id } })) as AuditRow | null;
      if (!row) return null;

      return { ...row, integrity: writer().verify(row) };
    },

    async stats(filters: LogFilters, tzOffsetMinutes: number): Promise<StatsResult> {
      const to = filters.to ?? new Date();
      const from = filters.from ?? new Date(to.getTime() - 29 * DAY_MS);
      const scoped: LogFilters = { ...filters, from, to };
      const where = toWhere(scoped);

      const total = await query().count({ where });

      // One narrow read feeds every widget. Bucketing in JS keeps this identical across SQLite,
      // PostgreSQL and MySQL, which disagree on date functions.
      const rows = (await query().findMany({
        select: ['occurredAt', 'category', 'outcome', 'action', 'actorId', 'actorType', 'actorEmail', 'actorName', 'targetUid'],
        where,
        orderBy: { occurredAt: 'desc' },
        limit: STATS_SAMPLE_LIMIT,
      })) as AuditRow[];

      const byCategory: Record<string, number> = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
      const days = new Map<string, { count: number; failures: number }>();
      const actors = new Map<string, { label: string; type: string; count: number }>();
      const contentTypes = new Map<string, number>();
      let failures = 0;
      let failedLogins = 0;

      // Every day in the range gets a bucket, so a quiet day shows as zero rather than vanishing.
      for (let time = from.getTime(); time <= to.getTime() + DAY_MS; time += DAY_MS) {
        const day = localDay(new Date(time), tzOffsetMinutes);
        if (day > localDay(to, tzOffsetMinutes)) break;
        days.set(day, { count: 0, failures: 0 });
      }

      for (const row of rows) {
        byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;

        const day = localDay(new Date(row.occurredAt), tzOffsetMinutes);
        const bucket = days.get(day) ?? { count: 0, failures: 0 };
        bucket.count += 1;

        if (row.outcome === 'failure') {
          failures += 1;
          bucket.failures += 1;
          if (row.category === 'auth') failedLogins += 1;
        }
        days.set(day, bucket);

        if (row.actorId && row.actorType !== 'anonymous') {
          const key = `${row.actorType}:${row.actorId}`;
          const actor = actors.get(key) ?? {
            label: row.actorName || row.actorEmail || `${row.actorType} #${row.actorId}`,
            type: row.actorType,
            count: 0,
          };
          actor.count += 1;
          actors.set(key, actor);
        }

        if (row.category === 'content' && row.targetUid) {
          contentTypes.set(row.targetUid, (contentTypes.get(row.targetUid) ?? 0) + 1);
        }
      }

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        total,
        sampled: total > rows.length,
        failures,
        failedLogins,
        activeActors: actors.size,
        byCategory,
        perDay: [...days.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, value]) => ({ date, ...value })),
        topActors: [...actors.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)
          .map(([key, value]) => ({ id: key.split(':').slice(1).join(':'), ...value })),
        topContentTypes: [...contentTypes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([uid, count]) => ({ uid, label: contentTypeLabel(uid), count })),
      };
    },

    /**
     * Values for the filter dropdowns, taken from the log itself so a deleted account or a
     * removed content type can still be filtered on. Knex is used for `DISTINCT`, which the
     * query engine does not offer; every value here is a fixed column name.
     */
    async filterOptions() {
      const knex = strapi.db.connection;
      const table = AUDIT_LOG_TABLE;

      const [actorRows, actionRows, uidRows] = await Promise.all([
        knex(table)
          .distinct(column('actorId'), column('actorType'), column('actorEmail'), column('actorName'))
          .whereNotNull(column('actorId'))
          .limit(1_000),
        knex(table).distinct(column('action')).orderBy(column('action')).limit(500),
        knex(table)
          .distinct(column('targetUid'))
          .where(column('category'), 'content')
          .whereNotNull(column('targetUid'))
          .limit(500),
      ]);

      const actors = new Map<string, { id: string; type: string; label: string; email?: string }>();
      for (const row of actorRows as Record<string, unknown>[]) {
        const id = String(row[column('actorId')]);
        const type = String(row[column('actorType')]);
        const key = `${type}:${id}`;
        if (actors.has(key)) continue;

        const email = row[column('actorEmail')] as string | null;
        const name = row[column('actorName')] as string | null;
        actors.set(key, {
          id,
          type,
          email: email ?? undefined,
          label: name && email ? `${name} (${email})` : (name ?? email ?? `${type} #${id}`),
        });
      }

      return {
        actors: [...actors.values()].sort((a, b) => a.label.localeCompare(b.label)),
        actions: (actionRows as Record<string, unknown>[]).map((row) => String(row[column('action')])),
        contentTypes: (uidRows as Record<string, unknown>[])
          .map((row) => String(row[column('targetUid')]))
          .map((uid) => ({ uid, label: contentTypeLabel(uid) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        categories: [...CATEGORIES],
      };
    },

    /**
     * Rows for an export, newest first, in pages. Keyset pagination on `id` keeps each page a
     * cheap index seek however deep the export goes, where `OFFSET` would rescan.
     */
    async *exportRows(filters: LogFilters, maxRows: number): AsyncGenerator<AuditRow> {
      const base = toWhere(filters);
      let lastId: number | null = null;
      let emitted = 0;

      while (emitted < maxRows) {
        const where: Record<string, unknown> =
          lastId === null ? base : { $and: [base, { id: { $lt: lastId } }] };

        const page = (await query().findMany({
          where,
          orderBy: { id: 'desc' },
          limit: Math.min(EXPORT_PAGE, maxRows - emitted),
        })) as AuditRow[];

        if (page.length === 0) return;

        for (const row of page) {
          yield row;
          emitted += 1;
        }

        lastId = Number(page[page.length - 1]!.id);
        if (page.length < EXPORT_PAGE) return;
      }
    },

    async count(filters: LogFilters): Promise<number> {
      return query().count({ where: toWhere(filters) });
    },

    /** Re-checks signatures for rows matching the filters, up to `limit`. */
    async verify(filters: LogFilters, limit: number) {
      let checked = 0;
      const counts: Record<Integrity, number> = { valid: 0, invalid: 0, unsigned: 0, unverifiable: 0 };
      const invalidIds: number[] = [];

      for await (const row of this.exportRows(filters, limit)) {
        checked += 1;
        const integrity = writer().verify(row) as Integrity;
        counts[integrity] += 1;
        if (integrity === 'invalid' && invalidIds.length < 100) invalidIds.push(Number(row.id));
      }

      return { checked, ...counts, invalidIds, limitReached: checked >= limit };
    },

    async prune(retentionDays: number): Promise<number> {
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
      const result = (await query().deleteMany({ where: { occurredAt: { $lt: cutoff.toISOString() } } })) as {
        count?: number;
      };
      return result?.count ?? 0;
    },
  };
};
