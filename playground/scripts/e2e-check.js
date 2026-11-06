#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the audit log plugin against a real Strapi 5 server.
 *
 *   node scripts/e2e-check.js
 *
 * Boots this playground on a throwaway SQLite file, drives it over HTTP the way the admin
 * panel and an API client would, and asserts what ends up in the log. Exits non-zero on any
 * failure. Nothing here touches the playground's normal database.
 */

const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');

const APP = path.resolve(__dirname, '..');
const PORT = 13377;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join('.tmp', `e2e-${randomBytes(6).toString('hex')}.db`);

Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  DATABASE_FILENAME: DB,
  AUDIT_DISABLE_RATE_LIMIT: 'true',
  STRAPI_TELEMETRY_DISABLED: 'true',
  STRAPI_DISABLE_UPDATE_NOTIFICATION: 'true',
  STRAPI_LOG_LEVEL: 'warn',
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail).slice(0, 300) });
};

async function http(method, url, { token, body, raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (!raw) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, json, text };
}

const tokenOf = (response) => response.json?.data?.token ?? response.json?.data?.accessToken;

async function main() {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi({ appDir: APP, distDir: APP }).load();
  await strapi.listen();

  const plugin = strapi.plugin('cms-audit-log');
  const flush = () => plugin.service('writer').flush();
  const logs = async (token, query = '') => (await http('GET', `/cms-audit-log/logs${query}`, { token })).json;

  try {
    // --- Boot ------------------------------------------------------------------------------
    const indexes = await strapi.db.connection.raw(`pragma index_list('cms_audit_logs')`);
    const names = indexes.map((index) => index.name);
    check('indexes created', ['occurred', 'actor', 'category', 'target'].every((part) => names.some((name) => name.includes(part))), names.join(', '));
    check('signing key from config', plugin.service('writer').keySource() === 'config', plugin.service('writer').keySource());

    // --- Sign-in ---------------------------------------------------------------------------
    const password = 'Str0ng!Passw0rd';
    const registered = await http('POST', '/admin/register-admin', {
      body: { firstname: 'Ada', lastname: 'Admin', email: 'ada@example.com', password },
    });
    check('register first admin', registered.status === 200 || registered.status === 201, registered.text);

    const badLogin = await http('POST', '/admin/login', { body: { email: 'ada@example.com', password: 'wrong-password-1' } });
    check('wrong password rejected', badLogin.status >= 400, badLogin.status);

    const login = await http('POST', '/admin/login', { body: { email: 'ada@example.com', password } });
    const token = tokenOf(login);
    check('login', Boolean(token), login.text);

    // --- Content Manager -------------------------------------------------------------------
    const cm = '/content-manager/collection-types/api::article.article';
    const created = await http('POST', cm, {
      token,
      body: { title: 'First post', body: 'Hello', views: 1, seo: { metaTitle: 'SEO one' }, sections: [] },
    });
    const documentId = created.json?.data?.documentId;
    check('CM create', Boolean(documentId), created.text);

    const updated = await http('PUT', `${cm}/${documentId}`, {
      token,
      body: {
        title: 'First post (edited)',
        body: 'Hello',
        views: 2,
        seo: { metaTitle: 'SEO two' },
        sections: [{ __component: 'blocks.hero', heading: 'Hero!' }],
      },
    });
    check('CM update', updated.status === 200, updated.text);

    const unchanged = await http('PUT', `${cm}/${documentId}`, {
      token,
      body: { title: 'First post (edited)', body: 'Hello', views: 2, seo: { metaTitle: 'SEO two' } },
    });
    check('CM save without changes', unchanged.status === 200, unchanged.text);

    const published = await http('POST', `${cm}/${documentId}/actions/publish`, { token, body: {} });
    check('CM publish', published.status === 200, published.text);

    const invalid = await http('PUT', `${cm}/${documentId}`, { token, body: { title: 'x'.repeat(500) } });
    check('CM invalid update rejected', invalid.status === 400, invalid.status);

    // --- Content API with an API token ------------------------------------------------------
    const apiToken = await http('POST', '/admin/api-tokens', {
      token,
      body: { name: 'E2E token', type: 'full-access', lifespan: null, description: '' },
    });
    const accessKey = apiToken.json?.data?.accessKey;
    check('create API token', Boolean(accessKey), apiToken.text);

    const viaApi = await http('POST', '/api/articles', { token: accessKey, body: { data: { title: 'From the API' } } });
    check('Content API create', viaApi.status === 200 || viaApi.status === 201, viaApi.text);

    const removed = await http('DELETE', `${cm}/${documentId}`, { token });
    check('CM delete', removed.status === 200, removed.text);

    // --- Second admin without audit permissions --------------------------------------------
    const roles = await http('GET', '/admin/roles', { token });
    const editor = roles.json?.data?.find((role) => role.code === 'strapi-editor');
    const invited = await http('POST', '/admin/users', {
      token,
      body: { firstname: 'Ed', lastname: 'Itor', email: 'ed@example.com', roles: [editor?.id] },
    });
    const registrationToken = invited.json?.data?.registrationToken;
    const editorRegistered = await http('POST', '/admin/register', {
      body: { registrationToken, userInfo: { firstname: 'Ed', lastname: 'Itor', password } },
    });
    const editorToken = tokenOf(editorRegistered);
    check('editor registered', Boolean(editorToken), editorRegistered.text);

    await flush();

    // --- What was recorded -----------------------------------------------------------------
    const page = await logs(token, '?pageSize=100');
    const rows = page?.results ?? [];
    const find = (action, predicate = () => true) => rows.find((row) => row.action === action && predicate(row));

    check('logs list', rows.length > 0, JSON.stringify(page).slice(0, 200));
    check('failed login recorded', find('admin.login.failed', (row) => row.outcome === 'failure' && row.targetLabel === 'ada@example.com' && row.ipAddress));
    check('login recorded with actor', find('admin.login', (row) => row.actorEmail === 'ada@example.com'));
    check('create recorded', find('entry.create', (row) => row.targetId === documentId && row.actorType === 'admin'));
    check('publish recorded', find('entry.publish', (row) => row.targetId === documentId));
    check('delete recorded', find('entry.delete', (row) => row.targetId === documentId && row.targetLabel === 'First post (edited)'));
    check('failed update recorded', find('entry.update', (row) => row.outcome === 'failure'));
    check('API token create attributed to token', find('entry.create', (row) => row.actorType === 'api-token' && row.actorName === 'E2E token'));
    check('admin user invite recorded', find('admin-user.create', (row) => row.targetLabel === 'ed@example.com' && row.actorEmail === 'ada@example.com'));
    check('first admin sign-up attributed to that admin', find('admin-user.create', (row) => row.targetLabel === 'ada@example.com' && row.actorEmail === 'ada@example.com'));

    // The Content Manager's publish action saves the form before publishing, so there is a
    // third update here. The rows are told apart by what they contain, not by position.
    const updates = rows.filter((row) => row.action === 'entry.update' && row.outcome === 'success' && row.targetId === documentId);
    check('successful updates recorded', updates.length >= 2, updates.length);

    const updateDetails = [];
    for (const row of updates) updateDetails.push((await http('GET', `/cms-audit-log/logs/${row.id}`, { token })).json);

    const detail = updateDetails.find((entry) => entry?.changes?.some((change) => change.field === 'title'));
    const editedRow = detail ? updates.find((row) => row.id === detail.id) : undefined;
    // Changes are reported at their own depth (`seo.metaTitle`, `sections[0]`), so compare the
    // top-level fields they belong to.
    const fields = [...new Set((detail?.changes ?? []).map((change) => change.field.split(/[.[]/)[0]))].sort();
    check('diff lists exactly the changed fields', JSON.stringify(fields) === JSON.stringify(['sections', 'seo', 'title', 'views']), JSON.stringify(updateDetails.map((entry) => entry?.changes)));
    check('diff has before and after', detail?.changes?.find((c) => c.field === 'title')?.before === 'First post' && detail?.changes?.find((c) => c.field === 'title')?.after === 'First post (edited)', JSON.stringify(detail?.changes));
    check('signature valid on read', detail?.integrity === 'valid', detail?.integrity);

    const noopDetail = updateDetails.find((entry) => entry?.details?.unchanged === true);
    check('no-change save marked unchanged', noopDetail && !noopDetail.changes, JSON.stringify(updateDetails.map((entry) => entry?.details)));

    const inviteRow = find('admin-user.create');
    const inviteDetail = inviteRow ? (await http('GET', `/cms-audit-log/logs/${inviteRow.id}`, { token })).text : '';
    check('admin user entry holds no secrets', inviteDetail && !/password|registrationToken"\s*:\s*"[a-f0-9]/i.test(inviteDetail), inviteDetail);

    // --- Admin users, roles and permissions: before and after -------------------------------
    const allRoles = (await http('GET', '/admin/roles', { token })).json?.data ?? [];
    const authorRole = allRoles.find((role) => role.code === 'strapi-author');
    const editorId = invited.json?.data?.id;

    const userEdit = await http('PUT', `/admin/users/${editorId}`, { token, body: { firstname: 'Edward', roles: [authorRole?.id] } });
    check('admin user role change accepted', userEdit.status === 200, userEdit.text);

    const roleRename = await http('PUT', `/admin/roles/${authorRole?.id}`, {
      token,
      body: { name: 'Author (renamed)', description: authorRole?.description ?? '' },
    });
    check('role rename accepted', roleRename.status === 200, roleRename.text);

    await flush();
    const permissionRowsBefore = (await logs(token, '?category=role&pageSize=100'))?.results?.filter((row) => row.action.startsWith('permission.')).length ?? 0;

    // What the Roles screen does: read the role's permissions, change some, send them all back.
    const currentPermissions = (await http('GET', `/admin/roles/${authorRole?.id}/permissions`, { token })).json?.data ?? [];
    const articlePerms = currentPermissions.filter((permission) => permission.subject === 'api::article.article');
    const narrowed = articlePerms.find((permission) => Array.isArray(permission.properties?.fields) && permission.properties.fields.includes('body'));
    const dropped = articlePerms.find((permission) => permission !== narrowed);
    const nextPermissions = currentPermissions
      .filter((permission) => permission !== dropped)
      .map((permission) => ({
        action: permission.action,
        subject: permission.subject,
        conditions: permission.conditions,
        properties:
          permission === narrowed
            ? { ...permission.properties, fields: permission.properties.fields.filter((field) => field !== 'body') }
            : permission.properties,
      }));
    const permissionsSave = await http('PUT', `/admin/roles/${authorRole?.id}/permissions`, { token, body: { permissions: nextPermissions } });
    check('role permission save accepted', permissionsSave.status === 200 && narrowed && dropped, `${permissionsSave.status} ${permissionsSave.text.slice(0, 200)}`);

    await flush();
    const roleRows = (await logs(token, '?category=admin-user,role&pageSize=100'))?.results ?? [];
    const detailOf = async (row) => (row ? (await http('GET', `/cms-audit-log/logs/${row.id}`, { token })).json : undefined);

    const userUpdate = await detailOf(roleRows.find((row) => row.action === 'admin-user.update' && row.targetId === String(editorId)));
    const userChanges = Object.fromEntries((userUpdate?.changes ?? []).map((change) => [change.field, change]));
    check(
      'admin user update shows roles before and after by name',
      JSON.stringify(userChanges.roles?.before) === JSON.stringify(['Editor']) && JSON.stringify(userChanges.roles?.after) === JSON.stringify(['Author']),
      JSON.stringify(userUpdate?.changes)
    );
    check('admin user update shows the name change', userChanges.firstname?.before === 'Ed' && userChanges.firstname?.after === 'Edward', JSON.stringify(userUpdate?.changes));
    // Two updates of this user: accepting the invite (by the user, password hidden) and the role
    // change (by Ada). Neither may be the event hub's after-only copy, which has no changes.
    const editorUpdates = [];
    for (const row of roleRows.filter((candidate) => candidate.action === 'admin-user.update' && candidate.targetId === String(editorId))) editorUpdates.push(await detailOf(row));
    const acceptInvite = editorUpdates.find((entry) => entry?.details?.selfService);
    check(
      'invite acceptance attributed to the user, password hidden',
      acceptInvite?.actorEmail === 'ed@example.com' && acceptInvite.changes?.some((change) => change.field === 'password' && change.kind === 'redacted' && change.before === undefined),
      JSON.stringify(editorUpdates.map((entry) => [entry?.actorEmail, entry?.details, entry?.changes]))
    );
    check(
      'no after-only duplicate of admin user updates',
      editorUpdates.length === 2 && editorUpdates.every((entry) => Array.isArray(entry?.changes) && entry.changes.length > 0),
      JSON.stringify(editorUpdates.map((entry) => [entry?.actorEmail, entry?.changes?.length, entry?.details]))
    );

    const roleUpdate = await detailOf(roleRows.find((row) => row.action === 'role.update' && row.targetId === String(authorRole?.id)));
    check('role rename shows before and after', roleUpdate?.changes?.[0]?.before === 'Author' && roleUpdate?.changes?.[0]?.after === 'Author (renamed)', JSON.stringify(roleUpdate?.changes));

    const permissionEntry = await detailOf(roleRows.find((row) => row.action === 'role.permissions.update'));
    const permissionSummary = JSON.stringify(permissionEntry?.changes?.map((change) => [change.path?.join(' › '), change.op, change.before, change.after]));
    check('permission save recorded as one entry for the role', permissionEntry?.targetLabel === 'Author (renamed)' && permissionEntry?.changes?.length === 2, permissionSummary);
    check(
      'revoked permission named by content type and action',
      permissionEntry?.changes?.some((change) => change.op === 'removed' && change.path?.[0] === 'Content › Article' && change.path.length === 2),
      permissionSummary
    );
    check(
      'narrowed permission shows the fields before and after',
      permissionEntry?.changes?.some((change) => change.path?.[2] === 'Fields' && change.op === 'removed' && JSON.stringify(change.before) === JSON.stringify(['body'])),
      permissionSummary
    );
    const permissionRowsAfter = (await logs(token, '?category=role&pageSize=100'))?.results?.filter((row) => row.action.startsWith('permission.')).length ?? 0;
    check('no per-permission noise for that save', permissionRowsAfter === permissionRowsBefore, `${permissionRowsBefore} → ${permissionRowsAfter}`);

    // --- Media folders and files -------------------------------------------------------------
    const products = (await http('POST', '/upload/folders', { token, body: { name: 'Products', parent: null } })).json?.data;
    const testFolder = (await http('POST', '/upload/folders', { token, body: { name: 'test', parent: null } })).json?.data;
    check('folders created', products?.id && testFolder?.id);
    const renamed = await http('PUT', `/upload/folders/${testFolder?.id}`, { token, body: { name: 'test-1', parent: products?.id } });
    check('folder renamed and moved', renamed.status === 200, renamed.text);

    const uploadForm = new FormData();
    uploadForm.append('files', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'hero.png');
    uploadForm.append('fileInfo', JSON.stringify({ folder: products?.id }));
    const uploaded = await fetch(`${BASE}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: uploadForm });
    const file = (await uploaded.json())?.[0];
    check('file uploaded', uploaded.status === 201 || uploaded.status === 200, uploaded.status);

    const info = new FormData();
    info.append('fileInfo', JSON.stringify({ name: 'hero-banner.png', alternativeText: 'Team photo', caption: '' }));
    const edited = await fetch(`${BASE}/upload?id=${file?.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: info });
    check('file details edited', edited.status === 200, edited.status);

    const archive = (await http('POST', '/upload/folders', { token, body: { name: 'Archive', parent: null } })).json?.data;
    const bulkMove = await http('POST', '/upload/actions/bulk-move', { token, body: { destinationFolderId: archive?.id, folderIds: [testFolder?.id], fileIds: [] } });
    check('folder moved with Move to…', bulkMove.status === 200, bulkMove.text.slice(0, 200));

    const bulk = await http('POST', '/upload/actions/bulk-delete', { token, body: { fileIds: [], folderIds: [products?.id, archive?.id] } });
    check('folder with contents deleted', bulk.status === 200, bulk.text);

    // --- API tokens and webhooks -----------------------------------------------------------
    const siteToken = (await http('POST', '/admin/api-tokens', { token, body: { name: 'Website', description: '', type: 'read-only', lifespan: null } })).json?.data;
    check('API token created', siteToken?.id);
    const tokenEdit = await http('PUT', `/admin/api-tokens/${siteToken?.id}`, {
      token,
      body: { name: 'Website build', description: 'Used by the site build', type: 'custom', permissions: ['api::article.article.find', 'api::article.article.findOne'] },
    });
    check('API token edited', tokenEdit.status === 200, tokenEdit.text.slice(0, 200));
    const regenerated = await http('POST', `/admin/api-tokens/${siteToken?.id}/regenerate`, { token, body: {} });
    const newKey = regenerated.json?.data?.accessKey;
    check('API token regenerated', regenerated.status === 201 || regenerated.status === 200, regenerated.status);
    await http('DELETE', `/admin/api-tokens/${siteToken?.id}`, { token });

    const hookResponse = await http('POST', '/admin/webhooks', {
      token,
      body: { name: 'Deploy', url: 'https://example.com/deploy?token=s3cr3t', headers: { Authorization: 'Bearer one' }, events: ['entry.create', 'entry.publish'] },
    });
    const hook = hookResponse.json?.data;
    check('webhook created', hook?.id, hookResponse.text.slice(0, 300));
    const hookEdit = await http('PUT', `/admin/webhooks/${hook?.id}`, {
      token,
      body: { name: 'Deploy', url: 'https://example.com/deploy?token=s3cr3t', headers: { Authorization: 'Bearer two' }, events: ['entry.publish', 'entry.update'], isEnabled: false },
    });
    check('webhook edited', hookEdit.status === 200, hookEdit.text.slice(0, 200));
    const hookDelete = await http('POST', '/admin/webhooks/batch-delete', { token, body: { ids: [hook?.id] } });
    check('webhook deleted', hookDelete.status === 200, hookDelete.text.slice(0, 200));

    await flush();
    const mediaRows = (await logs(token, '?category=media,settings&pageSize=100'))?.results ?? [];
    const entryFor = async (action, label) => {
      const row = mediaRows.find((candidate) => candidate.action === action && (!label || candidate.targetLabel === label));
      return row ? (await http('GET', `/cms-audit-log/logs/${row.id}`, { token })).json : undefined;
    };
    const at = (entry, label, op) => entry?.changes?.find((change) => change.path?.[0] === label && (!op || change.op === op));
    const summary = (entry) => JSON.stringify(entry?.changes?.map((change) => [change.path?.join(' › '), change.op, change.before, change.after]));

    const folderCreate = await entryFor('media-folder.create', 'test');
    check('folder create shows name and location', at(folderCreate, 'Name')?.after === 'test' && at(folderCreate, 'Location')?.after === 'Media Library', summary(folderCreate));
    const folderUpdate = (await Promise.all(mediaRows.filter((row) => row.action === 'media-folder.update' && row.targetLabel === 'test-1').map((row) => http('GET', `/cms-audit-log/logs/${row.id}`, { token }).then((response) => response.json)))).find((entry) => at(entry, 'Name'));
    check(
      'folder rename and move shown by name',
      at(folderUpdate, 'Name')?.before === 'test' && at(folderUpdate, 'Name')?.after === 'test-1' && at(folderUpdate, 'Location')?.after === 'Media Library › Products',
      summary(folderUpdate)
    );
    const folderDeletes = mediaRows.filter((row) => row.action === 'media-folder.delete').map((row) => row.targetLabel).sort();
    check('bulk folder delete names each folder', JSON.stringify(folderDeletes) === JSON.stringify(['Archive', 'Products', 'test-1']), JSON.stringify(folderDeletes));
    const bulkMoved = mediaRows.filter((row) => row.action === 'media-folder.update' && row.targetLabel === 'test-1');
    const moveEntries = await Promise.all(bulkMoved.map((row) => http('GET', `/cms-audit-log/logs/${row.id}`, { token }).then((response) => response.json)));
    check(
      'Move to… shows the old and new location',
      moveEntries.some((entry) => at(entry, 'Location')?.before === 'Media Library › Products' && at(entry, 'Location')?.after === 'Media Library › Archive'),
      JSON.stringify(moveEntries.map(summary))
    );

    const fileUpload = await entryFor('media.create');
    check('upload shows file name, type and folder', at(fileUpload, 'File name')?.after === 'hero.png' && at(fileUpload, 'Location')?.after === 'Media Library › Products' && at(fileUpload, 'Type')?.after === 'image/png', summary(fileUpload));
    const fileEdit = await entryFor('media.update', 'hero-banner.png');
    check('file edit shows name and alt text before and after', at(fileEdit, 'File name')?.before === 'hero.png' && at(fileEdit, 'Alternative text')?.after === 'Team photo', summary(fileEdit));
    const fileDelete = await entryFor('media.delete', 'hero-banner.png');
    check('file deleted with its folder is named', at(fileDelete, 'Location')?.before === 'Media Library › Products', summary(fileDelete));

    const tokenUpdate = await entryFor('api-token.update', 'Website build');
    check(
      'API token edit shows name, type and permissions',
      at(tokenUpdate, 'Name')?.after === 'Website build' && at(tokenUpdate, 'Token type')?.after === 'Custom' && JSON.stringify(at(tokenUpdate, 'Permissions', 'added')?.after) === JSON.stringify(['Article: find', 'Article: findOne']),
      summary(tokenUpdate)
    );
    const tokenRegen = await entryFor('api-token.regenerate');
    check('API token regeneration recorded without the key', at(tokenRegen, 'Token value')?.kind === 'redacted' && newKey && !JSON.stringify(tokenRegen).includes(newKey), summary(tokenRegen));
    check('API token delete recorded', Boolean(await entryFor('api-token.delete', 'Website build')));

    const hookUpdate = await entryFor('webhook.update', 'Deploy');
    check(
      'webhook edit shows events and enabled, hides header values',
      JSON.stringify(at(hookUpdate, 'Events', 'removed')?.before) === JSON.stringify(['entry.create']) &&
        JSON.stringify(at(hookUpdate, 'Events', 'added')?.after) === JSON.stringify(['entry.update']) &&
        at(hookUpdate, 'Header values')?.kind === 'redacted',
      summary(hookUpdate)
    );
    const hookCreate = await entryFor('webhook.create', 'Deploy');
    check('webhook URL token hidden', at(hookCreate, 'URL')?.after === 'https://example.com/deploy?token=•••', summary(hookCreate));
    check('webhook delete recorded', Boolean(await entryFor('webhook.delete', 'Deploy')));
    const settingsTexts = await Promise.all(mediaRows.map((row) => http('GET', `/cms-audit-log/logs/${row.id}`, { token }).then((response) => response.text)));
    check('no secrets in settings entries', !/s3cr3t|Bearer (one|two)/.test(settingsTexts.join(' ')));

    // --- Nested components inside a dynamic zone -------------------------------------------
    // Shaped like a page builder: sections (dynamic zone) → card grid → cards (repeatable) →
    // link (component), with a file and a relation on each card. The checks are about whether
    // an editor's change deep inside that tree is reported where it happened.
    const authorsCm = '/content-manager/collection-types/api::author.author';
    const ann = (await http('POST', authorsCm, { token, body: { name: 'Ann Author', email: 'ann@example.com' } })).json?.data?.documentId;
    const bob = (await http('POST', authorsCm, { token, body: { name: 'Bob Writer', email: 'bob@example.com' } })).json?.data?.documentId;
    check('authors for nested relations', ann && bob);

    const nested = await http('POST', cm, {
      token,
      body: {
        title: 'Nested page',
        sections: [
          { __component: 'blocks.hero', heading: 'Top hero' },
          {
            __component: 'blocks.card-grid',
            heading: 'Why us',
            cards: [
              { title: 'Alpha', body: 'Alpha body text', link: { label: 'More', url: '/alpha' }, author: { connect: [{ documentId: ann }] } },
              { title: 'Beta', body: 'Beta body', link: { label: 'More', url: '/beta' } },
            ],
          },
          { __component: 'blocks.cta', label: 'Contact', url: '/contact' },
        ],
      },
    });
    const nestedId = nested.json?.data?.documentId;
    check('nested create', Boolean(nestedId), nested.text);

    const firstPublish = await http('POST', `${cm}/${nestedId}/actions/publish`, { token, body: {} });
    check('nested first publish', firstPublish.status === 200, firstPublish.text);

    // Read the draft back the way the edit view does, and send the form back with its ids.
    const form = (await http('GET', `${cm}/${nestedId}`, { token })).json?.data;
    const grid = form?.sections?.find((section) => section.__component === 'blocks.card-grid');
    const cta = form?.sections?.find((section) => section.__component === 'blocks.cta');
    const alpha = grid?.cards?.find((item) => item.title === 'Alpha');
    const beta = grid?.cards?.find((item) => item.title === 'Beta');
    check('edit view returns component ids', grid?.id && alpha?.id && beta?.id && alpha?.link?.id && cta?.id, JSON.stringify(form?.sections).slice(0, 300));

    const nestedEdit = await http('PUT', `${cm}/${nestedId}`, {
      token,
      body: {
        title: 'Nested page',
        sections: [
          {
            __component: 'blocks.card-grid',
            id: grid?.id,
            heading: 'Why us',
            cards: [
              { id: beta?.id, title: 'Beta', body: 'Beta body', link: { id: beta?.link?.id, label: 'More', url: '/beta-2' } },
              {
                id: alpha?.id,
                title: 'Alpha',
                body: 'Alpha body text, now a little longer',
                link: { id: alpha?.link?.id, label: 'More', url: '/alpha' },
                author: { connect: [{ documentId: bob }], disconnect: [{ documentId: ann }] },
              },
              { title: 'Gamma', body: 'Brand new card', link: { label: 'Go', url: '/gamma' } },
            ],
          },
          { __component: 'blocks.cta', id: cta?.id, label: 'Contact us', url: '/contact' },
        ],
      },
    });
    check('nested update', nestedEdit.status === 200, nestedEdit.text);

    const secondPublish = await http('POST', `${cm}/${nestedId}/actions/publish`, { token, body: {} });
    check('nested second publish', secondPublish.status === 200, secondPublish.text);

    await http('PUT', `${cm}/${nestedId}`, { token, body: { title: 'Nested page (draft only)' } });
    const discarded = await http('POST', `${cm}/${nestedId}/actions/discard`, { token, body: {} });
    check('nested discard draft', discarded.status === 200, discarded.text);

    await flush();
    const nestedRows = (await logs(token, `?contentType=api::article.article&pageSize=100`))?.results?.filter((row) => row.targetId === nestedId) ?? [];
    const nestedDetail = async (action, predicate = () => true) => {
      for (const row of nestedRows.filter((candidate) => candidate.action === action)) {
        const entry = (await http('GET', `/cms-audit-log/logs/${row.id}`, { token })).json;
        if (predicate(entry)) return entry;
      }
      return undefined;
    };
    const byField = (entry) => Object.fromEntries((entry?.changes ?? []).map((change) => [change.field, change]));

    const createEntry = await nestedDetail('entry.create');
    const createdNested = byField(createEntry);
    check(
      'create lists each block with its content',
      createdNested['sections[0]']?.op === 'added' &&
        createdNested['sections[1]']?.after?.block === 'Card grid' &&
        createdNested['sections[1]']?.after?.cards?.[0]?.author === 'Ann Author' &&
        createdNested['sections[1]']?.after?.cards?.[0]?.link?.url === '/alpha' &&
        createdNested['sections[2]']?.after?.label === 'Contact',
      JSON.stringify(createEntry?.changes).slice(0, 600)
    );

    const firstPublishEntry = await nestedDetail('entry.publish', (entry) => entry?.details?.firstPublish === true);
    check('first publish says so', Boolean(firstPublishEntry), JSON.stringify(nestedRows.map((row) => row.action)));

    const editEntry = await nestedDetail('entry.update', (entry) => entry?.changes?.some((change) => change.field.includes('cards')));
    const edit = byField(editEntry);
    const editSummary = JSON.stringify(editEntry?.changes?.map((change) => [change.field, change.op, change.path?.join(' › ')]));
    check('removed block reported with its content', edit['sections[0]']?.op === 'removed' && edit['sections[0]']?.before?.heading === 'Top hero', editSummary);
    check('deep edit reported at its path', edit['sections[0].cards[0].link.url']?.before === '/beta' && edit['sections[0].cards[0].link.url']?.after === '/beta-2', editSummary);
    check(
      'deep edit has a readable path',
      edit['sections[0].cards[0].link.url']?.path?.join(' › ') === 'sections #1 · Card grid “Why us” › cards #1 “Beta” › link › url',
      editSummary
    );
    check('nested relation shown by name', edit['sections[0].cards[1].author']?.before === 'Ann Author' && edit['sections[0].cards[1].author']?.after === 'Bob Writer', editSummary);
    check('nested rich text change reported', edit['sections[0].cards[1].body']?.after === 'Alpha body text, now a little longer', editSummary);
    check('new card reported as added', edit['sections[0].cards[2]']?.op === 'added' && edit['sections[0].cards[2]']?.after?.title === 'Gamma', editSummary);
    check('reordered card reported as moved', (editEntry?.changes ?? []).filter((change) => change.op === 'moved').length === 1, editSummary);
    check('block field edit reported', edit['sections[1].label']?.before === 'Contact' && edit['sections[1].label']?.after === 'Contact us', editSummary);
    check(
      'untouched fields not reported',
      !edit.title && !edit['sections[0].heading'] && !edit['sections[0].cards[0].title'] && !edit['sections[0].cards[1].link.url'],
      editSummary
    );

    const publishEntry = await nestedDetail('entry.publish', (entry) => !entry?.details?.firstPublish);
    const wentLive = byField(publishEntry);
    check(
      'publish lists what went live',
      wentLive['sections[1].label']?.after === 'Contact us' && wentLive['sections[0].cards[0].link.url']?.after === '/beta-2' && wentLive['sections[0]']?.op === 'removed',
      JSON.stringify(publishEntry?.changes?.map((change) => [change.field, change.op]))
    );

    const discardEntry = await nestedDetail('entry.discard-draft');
    const discardedChanges = byField(discardEntry);
    check(
      'discard lists what was thrown away',
      discardedChanges.title?.before === 'Nested page (draft only)' && discardedChanges.title?.after === 'Nested page' && Object.keys(discardedChanges).length === 1,
      JSON.stringify(discardEntry?.changes)
    );
    check('nested entries signed', [createEntry, editEntry, publishEntry, discardEntry].every((entry) => entry?.integrity === 'valid'));

    // --- Filters ---------------------------------------------------------------------------
    const byActor = await logs(token, `?actor=${editedRow?.actorId}&actorType=admin&category=content&pageSize=100`);
    check('filter by user', byActor?.results?.length > 0 && byActor.results.every((row) => row.actorId === editedRow.actorId && row.category === 'content'));
    const failures = await logs(token, '?outcome=failure');
    check('filter by outcome', failures?.results?.every((row) => row.outcome === 'failure') && failures.results.length >= 2);
    const search = await logs(token, '?q=edited');
    check('free-text search', search?.results?.some((row) => row.targetLabel?.includes('edited')));
    const injected = await http('GET', '/cms-audit-log/logs?actor[$ne]=x', { token });
    check('operator injection rejected with 400', injected.status === 400, `${injected.status} ${injected.text}`);
    const badId = await http('GET', '/cms-audit-log/logs/1%20OR%201=1', { token });
    check('non-numeric id rejected', badId.status === 400, badId.status);

    const stats = (await http('GET', '/cms-audit-log/logs/stats?tz=330', { token })).json;
    check('stats', stats?.total >= rows.length && stats.failedLogins >= 1 && stats.perDay?.length === 30, JSON.stringify(stats).slice(0, 300));
    const options = (await http('GET', '/cms-audit-log/logs/options', { token })).json;
    check('filter options list both admins', options?.actors?.some((a) => a.email === 'ada@example.com'), JSON.stringify(options).slice(0, 200));

    // --- Access control --------------------------------------------------------------------
    const forbidden = await http('GET', '/cms-audit-log/logs', { token: editorToken });
    check('editor without permission gets 403', forbidden.status === 403, forbidden.status);
    const forbiddenExport = await http('GET', '/cms-audit-log/logs/export', { token: editorToken });
    check('editor cannot export', forbiddenExport.status === 403, forbiddenExport.status);
    const anonymous = await http('GET', '/cms-audit-log/logs');
    check('anonymous gets 401', anonymous.status === 401, anonymous.status);
    const contentApi = await http('GET', '/api/audit-logs', { token: accessKey });
    check('not exposed on the Content API', contentApi.status === 404 || contentApi.status === 405, contentApi.status);

    // --- Export ----------------------------------------------------------------------------
    const exported = await http('GET', '/cms-audit-log/logs/export?category=content', { token, raw: true });
    const lines = exported.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    check('export is CSV', exported.status === 200 && exported.headers.get('content-type')?.includes('text/csv'), exported.status);
    check('export has header and rows', lines[0]?.startsWith('id,occurred_at,action') && lines.length > 3, lines[0]);
    check('export sends no-store and nosniff', exported.headers.get('cache-control') === 'no-store' && exported.headers.get('x-content-type-options') === 'nosniff');

    await http('POST', cm, { token, body: { title: '=HYPERLINK("http://evil","click")' } });
    await flush();
    const evil = await http('GET', '/cms-audit-log/logs/export?q=HYPERLINK', { token, raw: true });
    check('formula injection neutralised in export', evil.text.includes(`'=HYPERLINK`) && !/,=HYPERLINK/.test(evil.text), evil.text.slice(0, 400));

    await flush();
    check('export itself audited', (await logs(token, '?action=audit.export')).results?.length >= 1);

    // --- Settings --------------------------------------------------------------------------
    const badSettings = await http('PUT', '/cms-audit-log/settings', { token, body: { retentionDays: 0 } });
    check('invalid settings rejected', badSettings.status === 400, badSettings.status);
    const massAssign = await http('PUT', '/cms-audit-log/settings', { token, body: { signingSecret: 'x' } });
    check('unknown setting rejected', massAssign.status === 400, massAssign.status);
    const lockedOff = await http('PUT', '/cms-audit-log/settings', { token, body: { disabledCategories: ['audit'] } });
    check('audit category cannot be disabled', lockedOff.status === 400, lockedOff.status);
    const goodSettings = await http('PUT', '/cms-audit-log/settings', { token, body: { retentionDays: 30, excludedContentTypes: ['api::tag.tag'] } });
    check('valid settings saved', goodSettings.status === 200 && goodSettings.json?.settings?.retentionDays === 30, goodSettings.text);

    await http('POST', '/content-manager/collection-types/api::tag.tag', { token, body: { name: 'skipped', slug: 'skipped' } });
    await flush();
    const settingsRow = await logs(token, '?action=audit.settings.update');
    check('settings change audited', settingsRow?.results?.length === 1);
    check('excluded type not recorded', (await logs(token, '?contentType=api::tag.tag')).results?.length === 0);

    // --- Tamper detection ------------------------------------------------------------------
    const before = (await http('GET', '/cms-audit-log/logs/verify', { token })).json;
    check('verify: all valid before tampering', before?.invalid === 0 && before?.valid > 0, JSON.stringify(before));

    await strapi.db.connection('cms_audit_logs').where('id', editedRow.id).update({ actor_email: 'someone-else@example.com' });
    const after = (await http('GET', '/cms-audit-log/logs/verify', { token })).json;
    check('verify: tampered row detected', after?.invalid === 1 && after.invalidIds?.includes(editedRow.id), JSON.stringify(after));
    const tampered = (await http('GET', `/cms-audit-log/logs/${editedRow.id}`, { token })).json;
    check('detail shows tampered row as invalid', tampered?.integrity === 'invalid', tampered?.integrity);

    // --- No write routes -------------------------------------------------------------------
    const del = await http('DELETE', `/cms-audit-log/logs/${editedRow.id}`, { token });
    const put = await http('PUT', `/cms-audit-log/logs/${editedRow.id}`, { token, body: {} });
    check('log entries cannot be deleted or edited over HTTP', [404, 405].includes(del.status) && [404, 405].includes(put.status), `${del.status} ${put.status}`);
  } finally {
    const original = process.removeAllListeners.bind(process);
    process.removeAllListeners = (event) => (event === undefined ? process : original(event));
    try {
      await strapi.destroy();
    } finally {
      process.removeAllListeners = original;
      fs.rmSync(path.join(APP, DB), { force: true });
    }
  }
}

main()
  .catch((error) => {
    check('script crashed', false, error && error.stack ? error.stack : error);
  })
  .finally(() => {
    const failed = results.filter((result) => !result.ok);
    for (const result of results) {
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `\n      ${result.detail}` : ''}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length > 0 ? 1 : 0);
  });
