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
    const fields = (detail?.changes ?? []).map((change) => change.field).sort();
    check('diff lists exactly the changed fields', JSON.stringify(fields) === JSON.stringify(['sections', 'seo', 'title', 'views']), JSON.stringify(updateDetails.map((entry) => entry?.changes)));
    check('diff has before and after', detail?.changes?.find((c) => c.field === 'title')?.before === 'First post' && detail?.changes?.find((c) => c.field === 'title')?.after === 'First post (edited)', JSON.stringify(detail?.changes));
    check('signature valid on read', detail?.integrity === 'valid', detail?.integrity);

    const noopDetail = updateDetails.find((entry) => entry?.details?.unchanged === true);
    check('no-change save marked unchanged', noopDetail && !noopDetail.changes, JSON.stringify(updateDetails.map((entry) => entry?.details)));

    const inviteRow = find('admin-user.create');
    const inviteDetail = inviteRow ? (await http('GET', `/cms-audit-log/logs/${inviteRow.id}`, { token })).text : '';
    check('admin user entry holds no secrets', inviteDetail && !/password|registrationToken"\s*:\s*"[a-f0-9]/i.test(inviteDetail), inviteDetail);

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
