import { LIMITS } from '../constants';
import { columnString } from './redact';

/** Fields tried, in order, for a human-readable name of an entry. */
export const LABEL_FIELDS: readonly string[] = [
  'title',
  'name',
  'displayName',
  'label',
  'heading',
  'slug',
  'username',
  'email',
  'code',
];

/**
 * Picks something an auditor can recognise an entry by.
 *
 * `mainField` is the Content Manager's configured display field for the type when known; it is
 * tried first so the log shows the same name the editor saw.
 */
export function entryLabel(
  entry: Record<string, unknown> | null | undefined,
  mainField?: string
): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;

  const candidates = mainField ? [mainField, ...LABEL_FIELDS] : LABEL_FIELDS;
  for (const field of candidates) {
    const value = entry[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return columnString(value.trim(), LIMITS.maxLabelChars) ?? undefined;
    }
    if (typeof value === 'number') return String(value);
  }

  return undefined;
}
