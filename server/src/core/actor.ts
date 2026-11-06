import { LIMITS } from '../constants';
import { columnString } from './redact';
import type { Actor, RequestInfo } from './types';

/** The parts of a Koa context this module reads. Kept structural so tests need no Koa. */
export interface RequestLike {
  method?: string;
  path?: string;
  request?: { ip?: string };
  ip?: string;
  get?(header: string): string;
  state?: {
    user?: Record<string, unknown>;
    auth?: { strategy?: { name?: string }; credentials?: Record<string, unknown> };
    route?: { info?: { type?: string } };
  };
}

export function displayName(user: Record<string, unknown> | undefined): string | undefined {
  if (!user) return undefined;

  const full = [user.firstname, user.lastname]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();

  if (full.length > 0) return full;
  if (typeof user.username === 'string' && user.username.length > 0) return user.username;
  return undefined;
}

export function adminActor(user: Record<string, unknown>): Actor {
  return {
    type: 'admin',
    id: user.id === undefined || user.id === null ? undefined : String(user.id),
    email: typeof user.email === 'string' ? user.email : undefined,
    name: displayName(user),
  };
}

/**
 * Works out who is behind a request.
 *
 * The auth strategy decides, not the route: an admin can call the Content API with an API
 * token, and that call should be attributed to the token, not to whoever is signed in to the
 * panel in another tab.
 */
export function resolveActor(ctx: RequestLike | undefined): Actor {
  if (!ctx) return { type: 'system' };

  const state = ctx.state ?? {};
  const strategy = state.auth?.strategy?.name;
  const credentials = state.auth?.credentials;
  const user = state.user;

  if (strategy === 'api-token' || strategy === 'content-api-token') {
    return {
      type: 'api-token',
      id: credentials?.id === undefined ? undefined : String(credentials.id),
      name: typeof credentials?.name === 'string' ? credentials.name : 'API token',
    };
  }

  if (strategy === 'users-permissions') {
    if (!user) return { type: 'anonymous' };
    return {
      type: 'end-user',
      id: user.id === undefined ? undefined : String(user.id),
      email: typeof user.email === 'string' ? user.email : undefined,
      name: typeof user.username === 'string' ? user.username : undefined,
    };
  }

  if (user && (strategy === 'admin' || state.route?.info?.type === 'admin')) {
    return adminActor(user);
  }

  if (user) {
    return {
      type: 'end-user',
      id: user.id === undefined ? undefined : String(user.id),
      email: typeof user.email === 'string' ? user.email : undefined,
    };
  }

  return { type: 'anonymous' };
}

/**
 * Request metadata for the row.
 *
 * `ctx.path` excludes the query string on purpose: query strings carry tokens and search terms
 * that do not belong in a log. `ctx.request.ip` honours `X-Forwarded-For` only when the server
 * is configured with `proxy: true`, which stops a client from spoofing its address otherwise.
 */
export function requestInfo(ctx: RequestLike | undefined): RequestInfo | undefined {
  if (!ctx) return undefined;

  let userAgent: string | undefined;
  try {
    userAgent = ctx.get?.('user-agent') || undefined;
  } catch {
    userAgent = undefined;
  }

  return {
    ip: columnString(ctx.request?.ip ?? ctx.ip, 64) ?? undefined,
    userAgent: columnString(userAgent, LIMITS.maxUserAgentChars) ?? undefined,
    method: columnString(ctx.method, 10) ?? undefined,
    path: columnString(ctx.path, LIMITS.maxPathChars) ?? undefined,
  };
}

/** Whether the request came through the admin panel's own routes. */
export function isAdminRequest(ctx: RequestLike | undefined): boolean {
  if (!ctx) return false;
  const strategy = ctx.state?.auth?.strategy?.name;
  return strategy === 'admin' || ctx.state?.route?.info?.type === 'admin';
}
