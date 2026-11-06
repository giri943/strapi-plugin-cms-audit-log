import type { AuditRow, FieldChange } from './types';

/**
 * Characters that make Excel, LibreOffice or Google Sheets read a cell as a formula. A log
 * records text that users typed (titles, emails, user agents), so any of these could be an
 * injection payload by the time it reaches a spreadsheet (CWE-1236).
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r＝＋－＠]/;

export function escapeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export const CSV_COLUMNS = [
  'id',
  'occurred_at',
  'action',
  'category',
  'outcome',
  'actor_type',
  'actor_id',
  'actor_email',
  'actor_name',
  'content_type',
  'target_id',
  'target_label',
  'locale',
  'changed_fields',
  'changes_json',
  'details_json',
  'ip_address',
  'user_agent',
  'request_method',
  'request_path',
  'signature',
] as const;

function json(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function changedFields(changes: unknown): string {
  if (!Array.isArray(changes)) return '';
  return (changes as FieldChange[]).map((change) => change.field).join('; ');
}

export function rowToCsvRecord(row: AuditRow): string[] {
  const cells: unknown[] = [
    row.id,
    iso(row.occurredAt),
    row.action,
    row.category,
    row.outcome,
    row.actorType,
    row.actorId,
    row.actorEmail,
    row.actorName,
    row.targetUid,
    row.targetId,
    row.targetLabel,
    row.localeCode,
    changedFields(row.changes),
    json(row.changes),
    json(row.details),
    row.ipAddress,
    row.userAgent,
    row.requestMethod,
    row.requestPath,
    row.signature,
  ];

  return cells.map((cell) => escapeFormula(cell === null || cell === undefined ? '' : String(cell)));
}
