import { ACTOR_TYPES, AUDIT_LOG_TABLE, CATEGORIES, OUTCOMES } from '../../constants';

/**
 * One recorded action.
 *
 * - Actor fields are copied into the row rather than related to `admin::user`, so the history
 *   still says who did something after that account is renamed or deleted.
 * - `locale` and `status` are reserved attribute names in Strapi 5, hence `localeCode`.
 * - Index columns are physical column names: Strapi 5 stores `occurredAt` as `occurred_at`,
 *   and the schema builder passes index columns through untranslated.
 */
export default {
  kind: 'collectionType',
  collectionName: AUDIT_LOG_TABLE,
  info: {
    singularName: 'audit-log',
    pluralName: 'audit-logs',
    displayName: 'Audit log',
    description: 'One recorded action in the CMS.',
  },
  options: {
    draftAndPublish: false,
    comment: '',
  },
  pluginOptions: {
    'content-api': { exposed: false },
    'content-manager': { visible: false },
    'content-type-builder': { visible: false },
    i18n: { localized: false },
  },
  indexes: [
    { name: `${AUDIT_LOG_TABLE}_occurred_idx`, columns: ['occurred_at'] },
    { name: `${AUDIT_LOG_TABLE}_actor_idx`, columns: ['actor_id', 'occurred_at'] },
    { name: `${AUDIT_LOG_TABLE}_category_idx`, columns: ['category', 'occurred_at'] },
    { name: `${AUDIT_LOG_TABLE}_target_idx`, columns: ['target_uid', 'target_id'] },
  ],
  attributes: {
    action: { type: 'string', required: true },
    category: { type: 'enumeration', enum: [...CATEGORIES], required: true },
    outcome: { type: 'enumeration', enum: [...OUTCOMES], required: true, default: 'success' },
    actorType: { type: 'enumeration', enum: [...ACTOR_TYPES], required: true },
    actorId: { type: 'string' },
    actorEmail: { type: 'string' },
    actorName: { type: 'string' },
    targetUid: { type: 'string' },
    targetId: { type: 'string' },
    targetLabel: { type: 'string' },
    localeCode: { type: 'string' },
    /** `[{ field, before, after }]`, values already redacted and truncated. */
    changes: { type: 'json' },
    /** Event-specific context: provider, error code, role id, export filters, and so on. */
    details: { type: 'json' },
    ipAddress: { type: 'string' },
    userAgent: { type: 'string' },
    requestMethod: { type: 'string' },
    requestPath: { type: 'string' },
    /** HMAC-SHA256 over the canonical row; see `core/signature.ts`. */
    signature: { type: 'string' },
    occurredAt: { type: 'datetime', required: true },
  },
};
