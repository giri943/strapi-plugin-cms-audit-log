import { Readable, Transform } from 'node:stream';
import { stringify } from 'csv-stringify';
import { strapiErrors } from '../utils/strapi-errors';
import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';
import { CSV_COLUMNS, rowToCsvRecord } from '../core/csv';
import {
  describeFilters,
  MAX_RANGE_DAYS,
  parseFilters,
  parsePagination,
  parseSortDirection,
  parseTzOffset,
  type LogFilters,
} from '../core/filters';
import type { AuditRow } from '../core/types';
import type { PluginConfig } from '../config';
import type { RequestContext } from '../types';

const VERIFY_LIMIT = 50_000;
const DAY_MS = 86_400_000;

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const errors = strapiErrors(strapi);

  function filtersOrThrow(query: Record<string, unknown>): LogFilters {
    const parsed = parseFilters(query);
    if (!parsed.ok) throw new errors.ValidationError(parsed.message);
    return parsed.value;
  }

  const plugin = () => strapi.plugin(PLUGIN_NAME);
  const logs = () => plugin().service('logs');
  const capture = () => plugin().service('capture');
  const config = () => (strapi.config.get(`plugin::${PLUGIN_NAME}`) ?? {}) as Partial<PluginConfig>;

  return {
    async list(ctx: RequestContext) {
      const query = ctx.query as Record<string, unknown>;
      const filters = filtersOrThrow(query);
      const { page, pageSize } = parsePagination(query);

      ctx.set('Cache-Control', 'no-store');
      ctx.body = await logs().list(filters, page, pageSize, parseSortDirection(query));
    },

    async findOne(ctx: RequestContext) {
      const raw = String(ctx.params.id ?? '');
      if (!/^\d{1,12}$/.test(raw)) throw new errors.ValidationError('id must be a number.');

      const row = await logs().findOne(Number(raw));
      if (!row) throw new errors.NotFoundError('No such audit log entry.');

      ctx.set('Cache-Control', 'no-store');
      ctx.body = row;
    },

    async stats(ctx: RequestContext) {
      const query = ctx.query as Record<string, unknown>;
      const filters = filtersOrThrow(query);

      if (filters.from && filters.to && filters.to.getTime() - filters.from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new errors.ValidationError(`The dashboard range is limited to ${MAX_RANGE_DAYS} days.`);
      }

      ctx.set('Cache-Control', 'no-store');
      ctx.body = await logs().stats(filters, parseTzOffset(query.tz));
    },

    async options(ctx: RequestContext) {
      ctx.set('Cache-Control', 'no-store');
      ctx.body = await logs().filterOptions();
    },

    /**
     * Streams matching rows as CSV. Rows are read in pages and written as they arrive, so
     * memory stays flat however large the export is. The export is itself audited, with the
     * filters used and the number of rows that left the system.
     */
    async export(ctx: RequestContext) {
      const filters = filtersOrThrow(ctx.query as Record<string, unknown>);
      const maxRows = config().maxExportRows ?? 50_000;
      const total = await logs().count(filters);
      const truncated = total > maxRows;

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const fileName = `audit-log-${stamp}.csv`;

      ctx.set('Content-Type', 'text/csv; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="${fileName}"`);
      ctx.set('Cache-Control', 'no-store');
      ctx.set('X-Content-Type-Options', 'nosniff');
      ctx.set('X-Export-Total', String(total));
      ctx.set('X-Export-Truncated', truncated ? 'true' : 'false');
      ctx.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Total, X-Export-Truncated');

      let written = 0;
      const source = Readable.from(logs().exportRows(filters, maxRows) as AsyncIterable<AuditRow>);
      const toRecord = new Transform({
        objectMode: true,
        transform(row: AuditRow, _encoding, callback) {
          written += 1;
          callback(null, rowToCsvRecord(row));
        },
      });
      const csv = stringify({ header: true, columns: [...CSV_COLUMNS], bom: true });

      const record = (outcome: 'success' | 'failure', error?: unknown) =>
        capture()
          .recordAudit('audit.export', {
            outcome,
            details: {
              filters: describeFilters(filters),
              rows: written,
              matched: total,
              truncated,
              ...(error ? { error: error instanceof Error ? error.message.slice(0, 200) : 'stream error' } : {}),
            },
          })
          .catch(() => undefined);

      let settled = false;
      const finish = (outcome: 'success' | 'failure', error?: unknown) => {
        if (settled) return;
        settled = true;
        void record(outcome, error);
      };

      const fail = (error: unknown) => {
        strapi.log.error(
          `[${PLUGIN_NAME}] Audit log export failed after ${written} row(s): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        csv.destroy(error instanceof Error ? error : new Error(String(error)));
        finish('failure', error);
      };

      source.on('error', fail);
      toRecord.on('error', fail);
      csv.on('end', () => finish('success'));

      source.pipe(toRecord).pipe(csv);
      ctx.body = csv;
    },

    async verify(ctx: RequestContext) {
      const filters = filtersOrThrow(ctx.query as Record<string, unknown>);
      const result = await logs().verify(filters, VERIFY_LIMIT);

      await capture().recordAudit('audit.verify', {
        outcome: result.invalid > 0 ? 'failure' : 'success',
        details: {
          filters: describeFilters(filters),
          checked: result.checked,
          invalid: result.invalid,
          unsigned: result.unsigned,
        },
      });

      ctx.set('Cache-Control', 'no-store');
      ctx.body = result;
    },
  };
};
