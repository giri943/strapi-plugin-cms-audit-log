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

/**
 * One changed field.
 *
 * `kind: 'reference'` marks a relation change, where the before value is not loaded; `after`
 * then summarises what was connected or disconnected instead of holding the full value.
 */
export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
  kind?: 'value' | 'reference' | 'redacted';
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
