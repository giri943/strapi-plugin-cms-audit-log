import { describe, expect, it } from 'vitest';
import { resolveActor, requestInfo } from '../src/core/actor';
import { escapeFormula, rowToCsvRecord, CSV_COLUMNS } from '../src/core/csv';
import { diffDocument, summariseRelationWrite } from '../src/core/diff';
import { mapEvent } from '../src/core/events';
import { parseFilters, parsePagination, parseTzOffset, toWhere } from '../src/core/filters';
import { entryLabel } from '../src/core/labels';
import { createRateLimiter } from '../src/core/rate-limit';
import { createSensitiveKeyMatcher, redactValue } from '../src/core/redact';
import { canonicalize, deriveKey, signRow, verifyRow } from '../src/core/signature';
import type { AuditRow } from '../src/core/types';
import { toRow } from '../src/services/writer';
import { DEFAULT_SETTINGS, validateSettings } from '../src/services/settings';
import { permissionActionDefinitions, PLUGIN_ACTIONS } from '../src/permissions';

const sensitive = createSensitiveKeyMatcher();

describe('redaction', () => {
  it('redacts secrets at any depth, case-insensitively', () => {
    const out = redactValue(
      { title: 'ok', password: 'p', nested: { resetPasswordToken: 't', apiKey: 'k', list: [{ clientSecret: 's' }] } },
      sensitive
    ) as Record<string, any>;

    expect(out.title).toBe('ok');
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.resetPasswordToken).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.list[0].clientSecret).toBe('[REDACTED]');
  });

  it('honours extra configured fields', () => {
    const matcher = createSensitiveKeyMatcher(['nationalId']);
    expect((redactValue({ nationalId: '123', name: 'a' }, matcher) as any).nationalId).toBe('[REDACTED]');
  });

  it('bounds long strings, wide arrays and cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactValue({ long: 'x'.repeat(5_000), list: Array.from({ length: 80 }, (_, i) => i), cyclic }, sensitive) as any;

    expect(out.long.length).toBeLessThanOrEqual(2_001);
    expect(out.list).toHaveLength(51);
    expect(out.cyclic.self).toBe('[circular]');
  });
});

describe('diffDocument', () => {
  const attributes = {
    title: { type: 'string' },
    body: { type: 'richtext' },
    secret: { type: 'password' },
    author: { type: 'relation' },
    seo: { type: 'component' },
    cover: { type: 'media' },
  };

  it('keeps only fields that really changed', () => {
    const changes = diffDocument({
      mode: 'update',
      data: { title: 'New', body: 'same', updatedAt: 'x' },
      before: { title: 'Old', body: 'same' },
      after: { title: 'New', body: 'same' },
      attributes,
      isSensitive: sensitive,
    });

    expect(changes).toEqual([{ field: 'title', kind: 'value', before: 'Old', after: 'New' }]);
  });

  it('never stores password values', () => {
    const changes = diffDocument({
      mode: 'update',
      data: { secret: 'hunter2' },
      before: { secret: 'hash' },
      after: null,
      attributes,
      isSensitive: sensitive,
    });
    expect(changes).toEqual([{ field: 'secret', kind: 'redacted' }]);
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('ignores component ids and untouched relations', () => {
    const changes = diffDocument({
      mode: 'update',
      data: { seo: { id: 9, metaTitle: 'A' }, author: { connect: [], disconnect: [] } },
      before: { seo: { id: 4, metaTitle: 'A' } },
      after: { seo: { id: 9, metaTitle: 'A' } },
      attributes,
      isSensitive: sensitive,
    });
    expect(changes).toEqual([]);
  });

  it('summarises relation writes and compares media by id', () => {
    const changes = diffDocument({
      mode: 'update',
      data: { author: { connect: [{ documentId: 'abc' }], disconnect: [] }, cover: 7 },
      before: { cover: { id: 3, url: '/a.png' } },
      after: { cover: { id: 7, url: '/b.png' } },
      attributes,
      isSensitive: sensitive,
    });

    expect(changes[0]).toMatchObject({ field: 'author', kind: 'reference', after: { connect: ['abc'], connectCount: 1 } });
    expect(changes[1]).toMatchObject({ field: 'cover', before: 3, after: 7 });
  });

  it('records initial values on create, skipping empty ones', () => {
    const changes = diffDocument({
      mode: 'create',
      data: { title: 'First', body: '' },
      before: null,
      after: { title: 'First', body: '' },
      attributes,
      isSensitive: sensitive,
    });
    expect(changes).toEqual([{ field: 'title', kind: 'value', before: null, after: 'First' }]);
  });

  it('summarises bare relation arrays', () => {
    expect(summariseRelationWrite(['a', 'b'])).toEqual({ set: ['a', 'b'], count: 2 });
    expect(summariseRelationWrite(undefined)).toBeNull();
  });
});

describe('signatures', () => {
  const key = deriveKey('x'.repeat(48));
  const row = toRow({
    action: 'entry.update',
    category: 'content',
    outcome: 'success',
    actor: { type: 'admin', id: '1', email: 'a@b.c', name: 'Ann' },
    targetUid: 'api::article.article',
    targetId: 'abc',
    changes: [{ field: 'title', before: 'a', after: 'b', kind: 'value' }],
    details: { b: 1, a: 2 },
    occurredAt: new Date('2026-01-02T03:04:05.678Z'),
  });

  it('verifies an untouched row, including after a database round trip', () => {
    const signed = { ...row, signature: signRow(row, key) };
    expect(verifyRow(signed, key)).toBe('valid');

    // What MySQL/SQLite can hand back: JSON as strings with keys reordered, dates as Date
    // objects without milliseconds, empty strings as null.
    const roundTripped = {
      ...signed,
      id: 42,
      details: JSON.stringify({ a: 2, b: 1 }),
      changes: JSON.stringify(row.changes),
      occurredAt: new Date('2026-01-02T03:04:05.000Z'),
    } as unknown as AuditRow;
    expect(verifyRow(roundTripped, key)).toBe('valid');
  });

  it('detects tampering with any signed field', () => {
    const signed = { ...row, signature: signRow(row, key) };
    expect(verifyRow({ ...signed, actorEmail: 'someone@else' }, key)).toBe('invalid');
    expect(verifyRow({ ...signed, occurredAt: '2026-01-03T03:04:05.000Z' }, key)).toBe('invalid');
    expect(verifyRow({ ...signed, changes: [] }, key)).toBe('invalid');
  });

  it('rejects a signature made with another key and reports unsigned rows', () => {
    const forged = { ...row, signature: signRow(row, deriveKey('y'.repeat(48))) };
    expect(verifyRow(forged, key)).toBe('invalid');
    expect(verifyRow({ ...row, signature: null }, key)).toBe('unsigned');
  });

  it('canonical form does not depend on key order', () => {
    expect(canonicalize({ ...row, details: { a: 2, b: 1 } })).toBe(canonicalize({ ...row, details: { b: 1, a: 2 } }));
  });
});

describe('filters', () => {
  it('accepts valid filters and builds a bound where clause', () => {
    const parsed = parseFilters({
      actor: '1,2',
      category: 'content',
      outcome: 'failure',
      contentType: 'api::article.article',
      from: '2026-01-01',
      to: '2026-01-31T23:59:59.999Z',
      q: 'hello',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const where = toWhere(parsed.value) as { $and: unknown[] };
    expect(where.$and).toContainEqual({ actorId: { $in: ['1', '2'] } });
    expect(where.$and).toContainEqual({ category: { $in: ['content'] } });
  });

  it.each([
    [{ category: 'content,bogus' }],
    [{ outcome: 'maybe' }],
    [{ actor: '1 OR 1=1' }],
    [{ actor: { $ne: null } }],
    [{ action: '$where' }],
    [{ contentType: "api::x.x'; drop table" }],
    [{ from: 'yesterday' }],
    [{ from: '2026-02-01', to: '2026-01-01' }],
    [{ q: 'x'.repeat(101) }],
    [{ q: 'a\u0000b' }],
  ])('rejects %j', (query) => {
    expect(parseFilters(query as Record<string, unknown>).ok).toBe(false);
  });

  it('rejects operator objects smuggled in through qs', () => {
    // qs turns `?actor[$ne]=` and `?contentType[$null]=true` into objects.
    expect(parseFilters({ actor: { $ne: '' } }).ok).toBe(false);
    expect(parseFilters({ category: { $in: ['content'] } }).ok).toBe(false);
    const parsed = parseFilters({ contentType: { $null: 'true' } });
    expect(parsed.ok && parsed.value.targetUid).toBeFalsy();
  });

  it('clamps pagination and timezone', () => {
    expect(parsePagination({ page: '-3', pageSize: '10000' })).toEqual({ page: 1, pageSize: 100 });
    expect(parseTzOffset('330')).toBe(330);
    expect(parseTzOffset('99999')).toBe(0);
  });
});

describe('csv', () => {
  it.each(['=HYPERLINK("x")', '+1', '-1+2', '@SUM(A1)', '\tcmd', '\rcmd', '＝1'])('neutralises %j', (value) => {
    expect(escapeFormula(value).startsWith("'")).toBe(true);
  });

  it('leaves ordinary text alone and produces one cell per column', () => {
    expect(escapeFormula('Hello')).toBe('Hello');

    const record = rowToCsvRecord({
      ...toRow({
        action: 'entry.update',
        category: 'content',
        outcome: 'success',
        actor: { type: 'admin', id: '1', name: '=cmd|calc' },
        changes: [{ field: 'title', before: 'a', after: 'b' }],
        occurredAt: new Date(),
      }),
      id: 1,
    });
    expect(record).toHaveLength(CSV_COLUMNS.length);
    expect(record[CSV_COLUMNS.indexOf('actor_name')]).toBe("'=cmd|calc");
    expect(record[CSV_COLUMNS.indexOf('changed_fields')]).toBe('title');
  });
});

describe('actor resolution', () => {
  it('attributes API token calls to the token, not to a user', () => {
    const actor = resolveActor({
      state: { auth: { strategy: { name: 'api-token' }, credentials: { id: 5, name: 'CI' } }, user: { id: 1 } },
    });
    expect(actor).toEqual({ type: 'api-token', id: '5', name: 'CI' });
  });

  it('resolves admins, end users, anonymous and system', () => {
    expect(
      resolveActor({ state: { auth: { strategy: { name: 'admin' } }, user: { id: 1, email: 'a@b.c', firstname: 'Ann', lastname: 'Lee' } } })
    ).toEqual({ type: 'admin', id: '1', email: 'a@b.c', name: 'Ann Lee' });
    expect(resolveActor({ state: { auth: { strategy: { name: 'users-permissions' } }, user: { id: 2, username: 'bob' } } })).toMatchObject({
      type: 'end-user',
      id: '2',
    });
    expect(resolveActor({ state: {} })).toEqual({ type: 'anonymous' });
    expect(resolveActor(undefined)).toEqual({ type: 'system' });
  });

  it('keeps the query string out of the stored path', () => {
    const info = requestInfo({ method: 'GET', path: '/admin/x', request: { ip: '10.0.0.1' }, get: () => 'UA' });
    expect(info).toEqual({ ip: '10.0.0.1', userAgent: 'UA', method: 'GET', path: '/admin/x' });
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window, then refuses with a retry hint', () => {
    const limiter = createRateLimiter(60_000);
    expect(limiter.take('u', 2, 0).allowed).toBe(true);
    expect(limiter.take('u', 2, 1).allowed).toBe(true);

    const refused = limiter.take('u', 2, 2);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);

    expect(limiter.take('u', 2, 60_001).allowed).toBe(true);
    expect(limiter.take('other', 2, 2).allowed).toBe(true);
  });
});

describe('event mapping', () => {
  it('never copies a whole admin user into the log', () => {
    const mapped = mapEvent('user.update', {
      user: { id: 3, email: 'x@y.z', password: 'hash', resetPasswordToken: 't', roles: [{ id: 1, name: 'Editor' }] },
    });
    expect(mapped?.action).toBe('admin-user.update');
    expect(JSON.stringify(mapped)).not.toContain('hash');
    expect(mapped?.details).toMatchObject({ email: 'x@y.z', roles: [1] });
  });

  it('attributes logins to the user in the payload', () => {
    const mapped = mapEvent('admin.auth.success', { user: { id: 1, email: 'a@b.c' }, provider: 'local' });
    expect(mapped).toMatchObject({ action: 'admin.login', category: 'auth', actorOverride: { type: 'admin', id: '1' } });
  });

  it('ignores entry events and unknown events', () => {
    expect(mapEvent('entry.update', {})).toBeNull();
    expect(mapEvent('something.else', {})).toBeNull();
  });
});

describe('labels', () => {
  it('prefers title, then other common names', () => {
    expect(entryLabel({ title: 'Hello', name: 'n' })).toBe('Hello');
    expect(entryLabel({ slug: 'my-post' })).toBe('my-post');
    expect(entryLabel({})).toBeUndefined();
  });
});

describe('settings validation', () => {
  it('rejects unknown keys, bad bounds and locked categories', () => {
    expect(validateSettings(DEFAULT_SETTINGS, { isAdmin: true }).ok).toBe(false);
    expect(validateSettings(DEFAULT_SETTINGS, { retentionDays: 0 }).ok).toBe(false);
    expect(validateSettings(DEFAULT_SETTINGS, { retentionDays: 1.5 }).ok).toBe(false);
    expect(validateSettings(DEFAULT_SETTINGS, { disabledCategories: ['audit'] }).ok).toBe(false);
    expect(validateSettings(DEFAULT_SETTINGS, { excludedContentTypes: ['not a uid'] }).ok).toBe(false);
    expect(validateSettings(DEFAULT_SETTINGS, { redactedFields: ['a-b'] }).ok).toBe(false);
  });

  it('applies a valid patch on top of the current settings', () => {
    const result = validateSettings(DEFAULT_SETTINGS, {
      retentionDays: 30,
      disabledCategories: ['media'],
      excludedContentTypes: ['api::log.log'],
    });
    expect(result).toMatchObject({ ok: true, value: { retentionDays: 30, disabledCategories: ['media'], captureContentApi: true } });
  });
});

describe('permissions', () => {
  it('uses uids Strapi accepts, each producing a distinct useRBAC flag', () => {
    const flags = new Set<string>();
    for (const definition of permissionActionDefinitions) {
      expect(definition.uid).toMatch(/^[a-z]([a-z|.|-]+)[a-z]$/);
      const flag = `can${definition.uid
        .split('-')
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join('')}`;
      expect(flags.has(flag)).toBe(false);
      flags.add(flag);
    }
    expect(Object.values(PLUGIN_ACTIONS)).toHaveLength(permissionActionDefinitions.length);
  });
});

describe('toRow', () => {
  it('bounds columns and redacts change values under sensitive names', () => {
    const row = toRow(
      {
        action: 'entry.update',
        category: 'content',
        outcome: 'success',
        actor: { type: 'admin', id: '1', email: 'e'.repeat(400) },
        changes: [{ field: 'nationalId', before: '1', after: '2' }],
        occurredAt: new Date(),
      },
      ['nationalId']
    );
    expect(row.actorEmail).toHaveLength(255);
    expect(row.changes).toEqual([{ field: 'nationalId', kind: 'redacted' }]);
  });
});
