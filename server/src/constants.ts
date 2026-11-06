export const PLUGIN_NAME = 'cms-audit-log' as const;
export const SETTINGS_STORE_KEY = 'settings' as const;
export const AUDIT_LOG_UID = `plugin::${PLUGIN_NAME}.audit-log` as const;
export const AUDIT_LOG_TABLE = 'cms_audit_logs' as const;

export const CATEGORIES = [
  'content',
  'media',
  'auth',
  'admin-user',
  'role',
  'schema',
  'audit',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const OUTCOMES = ['success', 'failure'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ACTOR_TYPES = ['admin', 'api-token', 'end-user', 'system', 'anonymous'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Document Service actions that change data. Reads are never recorded. */
export const WRITE_ACTIONS = [
  'create',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
  'clone',
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

/**
 * Event hub events the plugin records, and the category each belongs to.
 *
 * `entry.*` is deliberately absent: content changes are captured by the Document Service
 * middleware instead, because only there is the "before" state still readable for a diff.
 * Recording both would log every edit twice.
 */
export const EVENT_HUB_EVENTS: Record<string, Category> = {
  'media.create': 'media',
  'media.update': 'media',
  'media.delete': 'media',
  'media-folder.create': 'media',
  'media-folder.update': 'media',
  'media-folder.delete': 'media',
  'admin.auth.success': 'auth',
  'admin.logout': 'auth',
  'user.create': 'admin-user',
  'user.update': 'admin-user',
  'user.delete': 'admin-user',
  'role.create': 'role',
  'role.update': 'role',
  'role.delete': 'role',
  'permission.create': 'role',
  'permission.update': 'role',
  'permission.delete': 'role',
  'content-type.create': 'schema',
  'content-type.update': 'schema',
  'content-type.delete': 'schema',
  'component.create': 'schema',
  'component.update': 'schema',
  'component.delete': 'schema',
};

/**
 * Content types never recorded through the Document Service middleware. Their changes either
 * arrive through the event hub with a cleaner payload (media), or are the plugin's own rows.
 */
export const IGNORED_CONTENT_TYPES: readonly string[] = [
  AUDIT_LOG_UID,
  'plugin::upload.file',
  'plugin::upload.folder',
];

/**
 * Field names whose values never reach the log, whatever the schema says. Matched case-
 * insensitively against the last segment of the key, so `resetPasswordToken` and
 * `apiSecret` are both caught.
 */
export const ALWAYS_REDACTED_PATTERNS: readonly RegExp[] = [
  /password/i,
  /token/i,
  /secret/i,
  /^salt$/i,
  /^hash$/i,
  /apikey|api_key|accesskey|access_key/i,
  /^authorization$/i,
  /^cookie$/i,
];

export const REDACTED = '[REDACTED]' as const;

/** Upper bounds that keep one log row, and the request that writes it, small. */
export const LIMITS = {
  maxValueChars: 2_000,
  maxChangesPerEntry: 200,
  /** Serialised size of one row's changes; values past it are dropped, the paths kept. */
  maxChangesBytes: 256_000,
  maxDetailsBytes: 32_000,
  maxUserAgentChars: 512,
  maxPathChars: 512,
  maxLabelChars: 200,
  maxQueueLength: 10_000,
  flushBatchSize: 100,
  flushIntervalMs: 1_000,
} as const;
