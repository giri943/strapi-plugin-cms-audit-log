import { describe, expect, it, vi } from 'vitest';
import createCapture, { statusOfThrown } from '../src/services/capture';
import { DEFAULT_SETTINGS, type PluginSettings } from '../src/services/settings';
import type { AuditEntry } from '../src/core/types';

const ARTICLE = 'api::article.article';

function fakeStrapi(options: { settings?: Partial<PluginSettings>; stored?: Record<string, unknown>; writerThrows?: boolean; ctx?: unknown } = {}) {
  const queued: AuditEntry[] = [];
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const model = {
    info: { displayName: 'Article' },
    kind: 'collectionType',
    options: { draftAndPublish: true },
    attributes: { title: { type: 'string' }, views: { type: 'integer' } },
  };

  const strapi: any = {
    config: { get: () => ({ enabled: true }) },
    log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    requestContext: {
      get: () =>
        options.ctx ?? {
          method: 'PUT',
          path: '/content-manager/x',
          request: { ip: '1.2.3.4' },
          get: () => 'UA',
          state: { auth: { strategy: { name: 'admin' } }, user: { id: 7, email: 'ann@example.com', firstname: 'Ann' } },
        },
    },
    getModel: () => model,
    documents: () => ({ findOne: async () => options.stored ?? null }),
    plugin: () => ({
      service: (name: string) => {
        if (name === 'settings') return { get: async () => settings };
        if (name === 'writer')
          return {
            enqueue: (entry: AuditEntry) => {
              if (options.writerThrows) throw new Error('disk full');
              queued.push(entry);
            },
          };
        throw new Error(`unexpected service ${name}`);
      },
    }),
  };

  return { strapi, queued, capture: createCapture({ strapi }) };
}

const context = (action: string, params: Record<string, unknown>) => ({ action, uid: ARTICLE, params });

describe('document capture', () => {
  it('records an update with the diff and the admin who made it', async () => {
    const { capture, queued } = fakeStrapi({ stored: { title: 'Old', views: 1 } });

    const result = await capture.handleDocument(
      context('update', { documentId: 'doc1', data: { title: 'New', views: 1 } }),
      async () => ({ documentId: 'doc1', title: 'New', views: 1 })
    );

    expect(result).toEqual({ documentId: 'doc1', title: 'New', views: 1 });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      action: 'entry.update',
      outcome: 'success',
      actor: { type: 'admin', id: '7', email: 'ann@example.com' },
      targetId: 'doc1',
      targetLabel: 'New',
      changes: [{ field: 'title', before: 'Old', after: 'New' }],
      request: { ip: '1.2.3.4' },
    });
  });

  it('records a failed save and rethrows the original error', async () => {
    const { capture, queued } = fakeStrapi({ stored: { title: 'Old' } });
    const failure = Object.assign(new Error('title is too long'), { name: 'ValidationError', status: 400 });

    await expect(
      capture.handleDocument(context('update', { documentId: 'doc1', data: { title: 'x' } }), async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(queued[0]).toMatchObject({
      outcome: 'failure',
      details: { error: { name: 'ValidationError', status: 400 } },
    });
  });

  it('lets the save through when the audit writer is broken', async () => {
    const { capture, strapi } = fakeStrapi({ writerThrows: true });

    await expect(
      capture.handleDocument(context('create', { data: { title: 'A' } }), async () => ({ documentId: 'd', title: 'A' }))
    ).resolves.toEqual({ documentId: 'd', title: 'A' });
    expect(strapi.log.error).toHaveBeenCalled();
  });

  it('skips reads, excluded types, and Content API writes when switched off', async () => {
    const next = vi.fn(async () => ({}));

    const reads = fakeStrapi();
    await reads.capture.handleDocument(context('findMany', {}), next);
    expect(reads.queued).toHaveLength(0);

    const excluded = fakeStrapi({ settings: { excludedContentTypes: [ARTICLE] } });
    await excluded.capture.handleDocument(context('create', { data: { title: 'A' } }), next);
    expect(excluded.queued).toHaveLength(0);

    const contentApi = fakeStrapi({
      settings: { captureContentApi: false },
      ctx: { state: { auth: { strategy: { name: 'api-token' }, credentials: { id: 1, name: 'CI' } } } },
    });
    await contentApi.capture.handleDocument(context('create', { data: { title: 'A' } }), next);
    expect(contentApi.queued).toHaveLength(0);

    expect(next).toHaveBeenCalledTimes(3);
  });

  it('records system writes only when asked to', async () => {
    const off = fakeStrapi({ ctx: undefined });
    off.strapi.requestContext.get = () => undefined;
    await off.capture.handleDocument(context('create', { data: { title: 'A' } }), async () => ({}));
    expect(off.queued).toHaveLength(0);

    const on = fakeStrapi({ settings: { captureSystem: true } });
    on.strapi.requestContext.get = () => undefined;
    await on.capture.handleDocument(context('create', { data: { title: 'A' } }), async () => ({ documentId: 'd' }));
    expect(on.queued[0]?.actor).toEqual({ type: 'system' });
  });
});

describe('event capture', () => {
  it('attributes first-admin sign-up to the new account, not to "anonymous"', async () => {
    const { capture, queued } = fakeStrapi({ ctx: { method: 'POST', path: '/admin/register-admin', state: {}, get: () => '' } });
    await capture.handleEvent('user.create', { user: { id: 1, email: 'ada@example.com', firstname: 'Ada' } });

    expect(queued[0]).toMatchObject({
      action: 'admin-user.create',
      actor: { type: 'admin', id: '1', email: 'ada@example.com' },
      details: { selfService: true },
    });
  });

  it('keeps the signed-in admin as the actor when one exists', async () => {
    const { capture, queued } = fakeStrapi();
    await capture.handleEvent('user.create', { user: { id: 2, email: 'new@example.com' } });
    expect(queued[0]?.actor).toMatchObject({ type: 'admin', id: '7' });
    expect(queued[0]?.details).not.toHaveProperty('selfService');
  });
});

describe('login failure middleware', () => {
  it('records a failed sign-in without reading the password', async () => {
    const { capture, queued } = fakeStrapi();
    const body = { email: 'Ann@Example.com' } as Record<string, unknown>;
    Object.defineProperty(body, 'password', {
      get() {
        throw new Error('password must not be read');
      },
      enumerable: true,
    });

    const ctx: any = { method: 'POST', path: '/admin/login', status: 400, request: { body, ip: '9.9.9.9' }, get: () => 'UA', state: {} };
    await capture.loginFailureMiddleware()(ctx, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queued[0]).toMatchObject({
      action: 'admin.login.failed',
      category: 'auth',
      outcome: 'failure',
      actor: { type: 'anonymous' },
      targetLabel: 'ann@example.com',
      request: { ip: '9.9.9.9' },
    });
  });

  it('records a failed sign-in thrown as a bare ApplicationError (Strapi 5.0)', async () => {
    const { capture, queued } = fakeStrapi();
    const ctx: any = { method: 'POST', path: '/admin/login', status: 404, request: { body: { email: 'a@b.co' } }, get: () => '', state: {} };
    const error = Object.assign(new Error('Invalid credentials'), { name: 'ApplicationError' });

    await expect(capture.loginFailureMiddleware()(ctx, async () => Promise.reject(error))).rejects.toBe(error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queued[0]).toMatchObject({ action: 'admin.login.failed', details: { status: 400 } });
  });

  it('maps thrown errors to the status Strapi will send', () => {
    expect(statusOfThrown(Object.assign(new Error(), { name: 'RateLimitError' }))).toBe(429);
    expect(statusOfThrown(Object.assign(new Error(), { name: 'ApplicationError', status: 401 }))).toBe(401);
    expect(statusOfThrown(new Error('boom'))).toBe(500);
  });

  it('ignores successful sign-ins and other routes', async () => {
    const { capture, queued } = fakeStrapi();
    await capture.loginFailureMiddleware()({ method: 'POST', path: '/admin/login', status: 200, state: {} } as any, async () => undefined);
    await capture.loginFailureMiddleware()({ method: 'POST', path: '/api/x', status: 400, state: {} } as any, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queued).toHaveLength(0);
  });
});
