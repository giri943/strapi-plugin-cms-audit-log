import { describe, expect, it, vi } from 'vitest';
import createCapture, { statusOfThrown } from '../src/services/capture';
import { DEFAULT_SETTINGS, type PluginSettings } from '../src/services/settings';
import type { AuditEntry } from '../src/core/types';

const ARTICLE = 'api::article.article';

type Stored = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown> | null);

function fakeStrapi(options: { settings?: Partial<PluginSettings>; stored?: Stored; writerThrows?: boolean; ctx?: unknown } = {}) {
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
    documents: () => ({
      findOne: async (params: Record<string, unknown>) =>
        typeof options.stored === 'function' ? options.stored(params) : (options.stored ?? null),
    }),
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

    expect([reads, excluded, contentApi].every((fake) => fake.queued.length === 0)).toBe(true);
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

  it('reads the result back before answering, so a later save cannot leak into this entry', async () => {
    // The stored row changes again right after this save returns, as it would when an editor
    // saves twice in quick succession. The entry must describe this save only.
    let stored: Record<string, unknown> = { title: 'Old' };
    const { capture, queued } = fakeStrapi({ stored: () => stored });

    await capture.handleDocument(context('update', { documentId: 'doc1', data: { title: 'New' } }), async () => {
      stored = { title: 'New' };
      return { documentId: 'doc1', title: 'New' };
    });
    stored = { title: 'Newer, from the next save' };

    expect(queued).toHaveLength(1);
    expect(queued[0]?.changes).toEqual([
      expect.objectContaining({ field: 'title', before: 'Old', after: 'New' }),
    ]);
  });

  it('records what a publish put live: the old live version against the draft', async () => {
    const { capture, queued } = fakeStrapi({
      stored: (params) => (params.status === 'published' ? { title: 'Live title', views: 1 } : { title: 'Draft title', views: 1 }),
    });

    await capture.handleDocument(context('publish', { documentId: 'doc1' }), async () => ({ entries: [{ documentId: 'doc1' }] }));

    expect(queued[0]).toMatchObject({
      action: 'entry.publish',
      targetLabel: 'Draft title',
      changes: [{ field: 'title', op: 'changed', before: 'Live title', after: 'Draft title' }],
    });
  });

  it('marks a first publish rather than listing the whole entry', async () => {
    const { capture, queued } = fakeStrapi({
      stored: (params) => (params.status === 'published' ? null : { title: 'Draft title' }),
    });

    await capture.handleDocument(context('publish', { documentId: 'doc1' }), async () => ({ entries: [] }));

    expect(queued[0]?.details).toMatchObject({ firstPublish: true });
    expect(queued[0]?.changes).toBeUndefined();
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
    expect(queued[0]?.details?.selfService).toBeUndefined();
  });

  it('lists an invited user as fields, with roles by name', async () => {
    const { capture, queued } = fakeStrapi();
    await capture.handleEvent('user.create', {
      user: { id: 2, email: 'new@example.com', firstname: 'New', roles: [{ id: 3, name: 'Editor' }] },
    });
    expect(queued[0]?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email', op: 'added', after: 'new@example.com' }),
        expect.objectContaining({ field: 'roles', op: 'added', after: ['Editor'] }),
      ])
    );
  });
});

describe('media files and folders', () => {
  /** A fake query engine over a few folders and one file. */
  function withMedia(fake: ReturnType<typeof fakeStrapi>) {
    const folders: Record<string, any>[] = [
      { id: 1, documentId: 'f1', name: 'Products', pathId: 3, path: '/3' },
      { id: 2, documentId: 'f2', name: 'test', pathId: 12, path: '/12' },
    ];
    const files: Record<string, any>[] = [
      { id: 9, documentId: 'x9', name: 'hero.png', alternativeText: null, caption: null, folderPath: '/3', mime: 'image/png', size: 12.5, url: '/uploads/hero.png' },
    ];
    const table = (uid: string) => (uid === 'plugin::upload.folder' ? folders : files);
    fake.strapi.db = {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => structuredClone(table(uid).find((row) => String(row.id) === String(where.id)) ?? null),
        findMany: async ({ where }: any) =>
          where?.pathId
            ? folders.filter((folder) => where.pathId.$in.includes(folder.pathId))
            : structuredClone(table(uid).filter((row) => !where?.id?.$in || where.id.$in.includes(row.id))),
      }),
    };
    return { folders, files };
  }

  const event = (uid: string, id: number, extra: Record<string, unknown> = {}) => ({
    model: { uid },
    params: { where: { id } },
    state: {} as Record<string, unknown>,
    ...extra,
  });

  it('records a folder rename and move with names, not path ids', async () => {
    const fake = fakeStrapi();
    const { folders } = withMedia(fake);
    const hooks = fake.capture.mediaLifecycles();

    const update = event('plugin::upload.folder', 2);
    await hooks.beforeUpdate(update);
    Object.assign(folders[1], { name: 'test-1', path: '/3/12' });
    await hooks.afterUpdate(update);

    expect(fake.queued[0]).toMatchObject({
      action: 'media-folder.update',
      targetLabel: 'test-1',
      changes: [
        { path: ['Name'], before: 'test', after: 'test-1' },
        { path: ['Location'], before: 'Media Library', after: 'Media Library › Products' },
      ],
    });
  });

  it('keeps the name and location of deleted folders and files', async () => {
    const fake = fakeStrapi();
    withMedia(fake);
    const hooks = fake.capture.mediaLifecycles();

    const many = { ...event('plugin::upload.folder', 0), params: { where: { id: { $in: [2] } } } };
    await hooks.beforeDeleteMany(many);
    await hooks.afterDeleteMany(many);

    const one = event('plugin::upload.file', 9);
    await hooks.beforeDelete(one);
    await hooks.afterDelete(one);

    expect(fake.queued.map((entry) => [entry.action, entry.targetLabel])).toEqual([
      ['media-folder.delete', 'test'],
      ['media.delete', 'hero.png'],
    ]);
    expect(fake.queued[1].changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['Location'], op: 'removed', before: 'Media Library › Products' })])
    );
  });

  it('skips file updates nobody can see, such as regenerated formats', async () => {
    const fake = fakeStrapi();
    withMedia(fake);
    const hooks = fake.capture.mediaLifecycles();

    const update = event('plugin::upload.file', 9);
    await hooks.beforeUpdate(update);
    await hooks.afterUpdate(update);
    expect(fake.queued).toHaveLength(0);
  });
});

describe('API tokens and webhooks', () => {
  const adminCtx = (method: string, path: string): any => ({
    method,
    path,
    status: 200,
    state: { auth: { strategy: { name: 'admin' } }, user: { id: 7, email: 'ann@example.com', firstname: 'Ann' } },
    request: { ip: '1.2.3.4' },
    get: () => 'UA',
  });

  function withSettings(fake: ReturnType<typeof fakeStrapi>) {
    const rows: Record<string, any[]> = {
      'strapi::webhook': [
        { id: 1, name: 'Deploy', url: 'https://hooks.example.com/a?token=s3cr3t', enabled: true, events: ['entry.publish'], headers: { Authorization: 'Bearer one' } },
      ],
      'admin::api-token': [{ id: 4, name: 'Website', description: '', type: 'read-only', lifespan: null, expiresAt: null, permissions: [] }],
      'admin::transfer-token': [],
    };
    fake.strapi.db = { query: (uid: string) => ({ findMany: async () => structuredClone(rows[uid] ?? []) }) };
    return rows;
  }

  it('records a webhook edit, hiding header values and URL query values', async () => {
    const fake = fakeStrapi();
    const rows = withSettings(fake);

    await fake.capture.settingsMiddleware()(adminCtx('PUT', '/admin/webhooks/1'), async () => {
      Object.assign(rows['strapi::webhook'][0], { events: ['entry.publish', 'entry.update'], headers: { Authorization: 'Bearer two' } });
    });

    expect(fake.queued).toHaveLength(1);
    expect(fake.queued[0]).toMatchObject({
      action: 'webhook.update',
      category: 'settings',
      targetLabel: 'Deploy',
      changes: [
        { path: ['Events'], op: 'added', after: ['entry.update'] },
        { path: ['Header values'], op: 'changed', kind: 'redacted' },
      ],
    });
    expect(JSON.stringify(fake.queued)).not.toMatch(/Bearer|s3cr3t/);
  });

  it('records webhook create and bulk delete, one entry per webhook', async () => {
    const fake = fakeStrapi();
    const rows = withSettings(fake);

    await fake.capture.settingsMiddleware()(adminCtx('POST', '/admin/webhooks'), async () => {
      rows['strapi::webhook'].push({ id: 2, name: 'Search', url: 'https://search.example.com', enabled: true, events: ['entry.create'], headers: {} });
    });
    await fake.capture.settingsMiddleware()(adminCtx('POST', '/admin/webhooks/batch-delete'), async () => {
      rows['strapi::webhook'] = [];
    });

    expect(fake.queued.map((entry) => [entry.action, entry.targetLabel])).toEqual([
      ['webhook.create', 'Search'],
      ['webhook.delete', 'Deploy'],
      ['webhook.delete', 'Search'],
    ]);
    expect(fake.queued[1].changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['URL'], before: 'https://hooks.example.com/a?token=•••' })])
    );
  });

  it('records an API token regeneration without the token, and a type change', async () => {
    const fake = fakeStrapi();
    const rows = withSettings(fake);

    await fake.capture.settingsMiddleware()(adminCtx('POST', '/admin/api-tokens/4/regenerate'), async () => undefined);
    await fake.capture.settingsMiddleware()(adminCtx('PUT', '/admin/api-tokens/4'), async () => {
      Object.assign(rows['admin::api-token'][0], { type: 'full-access', lifespan: 7 * 86_400_000 });
    });

    expect(fake.queued[0]).toMatchObject({
      action: 'api-token.regenerate',
      changes: [{ path: ['Token value'], op: 'changed', kind: 'redacted' }],
    });
    expect(fake.queued[1]).toMatchObject({
      action: 'api-token.update',
      changes: [
        { path: ['Token type'], before: 'Read-only', after: 'Full access' },
        { path: ['Duration'], before: 'Unlimited', after: '7 days' },
      ],
    });
  });

  it('records nothing for a refused request or a webhook test call', async () => {
    const fake = fakeStrapi();
    withSettings(fake);

    const refused = adminCtx('PUT', '/admin/webhooks/1');
    refused.status = 400;
    await fake.capture.settingsMiddleware()(refused, async () => undefined);
    await fake.capture.settingsMiddleware()(adminCtx('POST', '/admin/webhooks/1/trigger'), async () => undefined);

    expect(fake.queued).toHaveLength(0);
  });
});

describe('admin user and role updates', () => {
  /** A fake query engine over one admin user, one role and its permissions. */
  function withAdminData(fake: ReturnType<typeof fakeStrapi>) {
    const rows: Record<string, any> = {
      user: { id: 5, firstname: 'Maziya', lastname: 'Shaikh', email: 'maziya@example.com', isActive: true, blocked: false, roles: [{ id: 3, name: 'Editor' }] },
      role: { id: 4, name: 'Editor', description: '' },
      permissions: [{ action: 'plugin::content-manager.explorer.read', subject: 'api::page.page', properties: { fields: ['title'] }, conditions: [] }],
    };
    fake.strapi.db = {
      query: (uid: string) => ({
        findOne: async () => (uid === 'admin::user' ? structuredClone(rows.user) : structuredClone(rows.role)),
        findMany: async () => structuredClone(rows.permissions),
      }),
    };
    fake.strapi.service = () => ({ actionProvider: { get: () => ({ displayName: 'Read' }) }, conditionProvider: { get: () => undefined } });
    fake.strapi.getModel = (uid: string) =>
      uid === 'api::page.page' ? { info: { displayName: 'Pages' } } : { info: { displayName: 'Article' }, attributes: {} };
    return rows;
  }

  const lifecycle = async (fake: ReturnType<typeof fakeStrapi>, uid: string, data: Record<string, unknown>, write: () => void) => {
    const subscriber = fake.capture.adminLifecycles();
    const event = { model: { uid }, params: { where: { id: 5 }, data }, state: {} as Record<string, unknown> };
    await subscriber.beforeUpdate(event);
    write();
    await subscriber.afterUpdate(event);
  };

  it('records a role change on an admin user as before and after, and skips the event hub copy', async () => {
    const fake = fakeStrapi();
    const rows = withAdminData(fake);

    await lifecycle(fake, 'admin::user', { roles: [4] }, () => {
      rows.user.roles = [{ id: 4, name: 'Author' }];
    });
    await fake.capture.handleEvent('user.update', { user: { id: 5, email: 'maziya@example.com', roles: [4] } });

    expect(fake.queued).toHaveLength(1);
    expect(fake.queued[0]).toMatchObject({
      action: 'admin-user.update',
      targetLabel: 'maziya@example.com',
      actor: { type: 'admin', id: '7' },
      changes: [{ field: 'roles', path: ['Roles'], before: ['Editor'], after: ['Author'] }],
    });
  });

  it('ignores token bookkeeping writes and their events', async () => {
    const fake = fakeStrapi();
    withAdminData(fake);

    await lifecycle(fake, 'admin::user', { resetPasswordToken: 'abc' }, () => undefined);
    await fake.capture.handleEvent('user.update', { user: { id: 5, email: 'maziya@example.com' } });

    expect(fake.queued).toHaveLength(0);
  });

  it('turns a role permission save into one entry and drops the per-permission events', async () => {
    const fake = fakeStrapi();
    const rows = withAdminData(fake);
    const ctx: any = {
      method: 'PUT',
      path: '/admin/roles/4/permissions',
      status: 200,
      state: { auth: { strategy: { name: 'admin' } }, user: { id: 7, email: 'ann@example.com', firstname: 'Ann' } },
      request: { ip: '1.2.3.4' },
      get: () => 'UA',
    };
    fake.strapi.requestContext.get = () => ctx;

    await fake.capture.permissionsMiddleware()(ctx, async () => {
      rows.permissions = [];
      await fake.capture.handleEvent('permission.delete', { permissions: [{ action: 'plugin::content-manager.explorer.read' }] });
    });

    expect(fake.queued).toHaveLength(1);
    expect(fake.queued[0]).toMatchObject({
      action: 'role.permissions.update',
      targetLabel: 'Editor',
      changes: [{ path: ['Content › Pages', 'Read'], op: 'removed', before: { Fields: ['title'] } }],
    });
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
