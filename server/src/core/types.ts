import type { ActorType, Category, Outcome } from '../constants';

export interface Actor {
  type: ActorType;
  id?: string;
  email?: string;
  name?: string;
}

export interface RequestInfo {
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
}

/** What happened at one place in the document. */
export type ChangeOp = 'added' | 'removed' | 'changed' | 'moved';

/**
 * One change, at any depth of the document.
 *
 * - `field` is a machine path into the document: `title`, `seo.metaTitle`,
 *   `layouts[1].cards[0].title`. List indexes are zero-based positions in the saved list.
 * - `path` is the same location for a person: field names, plus `layouts #2 · Hero` for a
 *   dynamic zone block or `cards #1 “Our values”` for a repeatable component item.
 * - `kind: 'block'` marks a whole component or dynamic zone block being added, removed or
 *   moved; its `before`/`after` hold a readable snapshot of the block's content.
 * - `kind: 'reference'` marks a relation change whose before value could not be loaded; `after`
 *   then summarises what was connected or disconnected.
 */
export interface FieldChange {
  field: string;
  path?: string[];
  op?: ChangeOp;
  before?: unknown;
  after?: unknown;
  kind?: 'value' | 'reference' | 'redacted' | 'block';
  /** Set by the writer when the value was dropped to keep the row within its size budget. */
  truncated?: boolean;
}

/** What a capture site hands to the writer. */
export interface AuditEntry {
  action: string;
  category: Category;
  outcome: Outcome;
  actor: Actor;
  request?: RequestInfo;
  targetUid?: string;
  targetId?: string;
  targetLabel?: string;
  localeCode?: string;
  changes?: FieldChange[];
  details?: Record<string, unknown>;
  occurredAt: Date;
}

/** The stored row, as the database query layer returns it. */
export interface AuditRow {
  id?: number;
  action: string;
  category: Category;
  outcome: Outcome;
  actorType: ActorType;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  targetUid: string | null;
  targetId: string | null;
  targetLabel: string | null;
  localeCode: string | null;
  changes: FieldChange[] | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  signature?: string | null;
  occurredAt: string | Date;
}
