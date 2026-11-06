import { getFetchClient } from '@strapi/strapi/admin';
import { PLUGIN_ID } from '../pluginId';

/** Strapi mounts plugin admin routes at `/{pluginId}/…`. */
const base = `/${PLUGIN_ID}`;

export type Category = 'content' | 'media' | 'auth' | 'admin-user' | 'role' | 'schema' | 'settings' | 'audit';
export type Outcome = 'success' | 'failure';
export type ActorType = 'admin' | 'api-token' | 'end-user' | 'system' | 'anonymous';
export type Integrity = 'valid' | 'invalid' | 'unsigned' | 'unverifiable';

export type ChangeOp = 'added' | 'removed' | 'changed' | 'moved';

/** See `FieldChange` in server/src/core/types.ts. Rows written by 0.1.0-beta.0 have no `path` or `op`. */
export interface FieldChange {
  field: string;
  path?: string[];
  op?: ChangeOp;
  before?: unknown;
  after?: unknown;
  kind?: 'value' | 'reference' | 'redacted' | 'block';
  truncated?: boolean;
}

export interface LogListItem {
  id: number;
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
  ipAddress: string | null;
  occurredAt: string;
}

export interface LogEntry extends LogListItem {
  changes: FieldChange[] | null;
  details: Record<string, unknown> | null;
  userAgent: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  signature: string | null;
  integrity: Integrity;
}

export interface LogPage {
  results: LogListItem[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

export interface Stats {
  from: string;
  to: string;
  total: number;
  sampled: boolean;
  failures: number;
  failedLogins: number;
  activeActors: number;
  byCategory: Record<Category, number>;
  perDay: Array<{ date: string; count: number; failures: number }>;
  topActors: Array<{ id: string; label: string; type: ActorType; count: number }>;
  topContentTypes: Array<{ uid: string; label: string; count: number }>;
}

export interface FilterOptions {
  actors: Array<{ id: string; type: ActorType; label: string; email?: string }>;
  actions: string[];
  contentTypes: Array<{ uid: string; label: string }>;
  categories: Category[];
}

export interface VerifyResult {
  checked: number;
  valid: number;
  invalid: number;
  unsigned: number;
  unverifiable: number;
  invalidIds: number[];
  limitReached: boolean;
}

export interface PluginSettings {
  retentionDays: number;
  captureContentApi: boolean;
  captureSystem: boolean;
  disabledCategories: Category[];
  excludedContentTypes: string[];
  redactedFields: string[];
}

export interface SettingsResponse {
  settings: PluginSettings;
  options: {
    categories: Category[];
    lockedCategories: Category[];
    contentTypes: Array<{ uid: string; label: string }>;
    retentionDays: { min: number; max: number; default: number };
  };
  deployment: {
    enabled: boolean;
    signingKey: 'config' | 'admin-secret' | 'none';
    maxExportRows?: number;
    exportsPerMinute?: number;
    readsPerMinute?: number;
  };
}

/** Query parameters the server accepts. Anything else is dropped before the request. */
export interface LogQuery {
  actor?: string;
  actorType?: string;
  category?: string;
  outcome?: string;
  action?: string;
  contentType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  tz?: number;
}

export function toSearch(query: LogQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { error?: { message?: string } } } }).response;
    const message = response?.data?.error?.message;
    if (typeof message === 'string') return message;
    if (typeof (error as { message?: unknown }).message === 'string') return (error as Error).message;
  }
  return 'The request failed.';
}

async function get<T>(path: string): Promise<T> {
  try {
    const { data } = await getFetchClient().get(`${base}${path}`);
    return data as T;
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export const api = {
  logs: (query: LogQuery) => get<LogPage>(`/logs${toSearch(query)}`),
  log: (id: number) => get<LogEntry>(`/logs/${encodeURIComponent(String(id))}`),
  stats: (query: LogQuery) => get<Stats>(`/logs/stats${toSearch(query)}`),
  options: () => get<FilterOptions>('/logs/options'),
  verify: (query: LogQuery) => get<VerifyResult>(`/logs/verify${toSearch(query)}`),
  settings: () => get<SettingsResponse>('/settings'),

  async saveSettings(patch: Partial<PluginSettings>): Promise<SettingsResponse> {
    try {
      const { data } = await getFetchClient().put(`${base}/settings`, patch);
      return data as SettingsResponse;
    } catch (error) {
      throw new Error(messageOf(error));
    }
  },

  exportPath: (query: LogQuery) => `${base}/logs/export${toSearch(query)}`,
};
