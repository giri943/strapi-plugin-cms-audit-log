import { describe, expect, it } from 'vitest';
import { resolveActor, requestInfo } from '../src/core/actor';
import { escapeFormula, rowToCsvRecord, CSV_COLUMNS } from '../src/core/csv';
import {
  blocksToText,
  buildPopulate,
  diffDocument,
  diffDocumentDetailed,
  summariseRelationWrite,
  type SchemaInfo,
} from '../src/core/diff';
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

    expect(changes).toEqual([
      { field: 'title', path: ['title'], op: 'changed', kind: 'value', before: 'Old', after: 'New' },
    ]);
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
    expect(changes).toEqual([{ field: 'secret', path: ['secret'], op: 'changed', kind: 'redacted' }]);
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
    expect(changes[1]).toMatchObject({ field: 'cover', op: 'changed', before: 'File #3', after: 'File #7' });
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
    expect(changes).toEqual([
      { field: 'title', path: ['title'], op: 'added', kind: 'value', before: null, after: 'First' },
    ]);
  });

  it('summarises bare relation arrays', () => {
    expect(summariseRelationWrite(['a', 'b'])).toEqual({ set: ['a', 'b'], count: 2 });
    expect(summariseRelationWrite(undefined)).toBeNull();
  });
});

describe('diffDocument on nested components and dynamic zones', () => {
  // Shaped like a page builder: Page.layouts (dynamic zone) → home layout → section → cards
  // (repeatable) → link (component), with files and relations at the bottom.
  const components: Record<string, SchemaInfo> = {
    'shared.link': { displayName: 'Link', attributes: { label: { type: 'string' }, url: { type: 'string' } } },
    'home.card': {
      displayName: 'Card',
      attributes: {
        title: { type: 'string' },
        image: { type: 'media' },
        link: { type: 'component', component: 'shared.link' },
        author: { type: 'relation', relation: 'oneToOne', target: 'api::author.author' },
        apiToken: { type: 'string' },
      },
    },
    'home.section': {
      displayName: 'Section',
      attributes: {
        heading: { type: 'string' },
        cards: { type: 'component', component: 'home.card', repeatable: true },
      },
    },
    'layouts.home-layout': {
      displayName: 'Home layout',
      attributes: { section_four: { type: 'component', component: 'home.section' } },
    },
    'layouts.cta': { displayName: 'CTA', attributes: { label: { type: 'string' } } },
  };
  const attributes = {
    title: { type: 'string' },
    layouts: { type: 'dynamiczone', components: ['layouts.home-layout', 'layouts.cta'] },
  };
  const getComponent = (uid: string) => components[uid];

  const card = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    image: { id: 10 + id, name: `card-${id}.png` },
    link: { id: 100 + id, label: 'More', url: `/c/${id}` },
    author: { documentId: 'auth1', name: 'Ann' },
    ...extra,
  });
  const home = (cards: unknown[]) => ({
    __component: 'layouts.home-layout',
    id: 1,
    section_four: { id: 5, heading: 'Why us', cards },
  });
  const cta = (id: number, label: string) => ({ __component: 'layouts.cta', id, label });

  const run = (before: unknown, after: unknown, mode: 'update' | 'create' | 'compare' = 'update') =>
    diffDocument({
      mode,
      data: mode === 'compare' ? undefined : { layouts: after },
      before: { layouts: before },
      after: { layouts: after },
      attributes,
      isSensitive: sensitive,
      getComponent,
    });

  it('reports an edit deep inside a block at its own path, and nothing else', () => {
    const before = [home([card(1, 'Alpha'), card(2, 'Beta')]), cta(1, 'Go')];
    const after = [home([card(1, 'Alpha'), card(2, 'Beta', { link: { id: 102, label: 'More', url: '/new' } })]), cta(1, 'Go')];

    expect(run(before, after)).toEqual([
      {
        field: 'layouts[0].section_four.cards[1].link.url',
        path: ['layouts #1 · Home layout', 'section_four', 'cards #2 “Beta”', 'link', 'url'],
        op: 'changed',
        kind: 'value',
        before: '/c/2',
        after: '/new',
      },
    ]);
  });

  it('matches items by id, so adding one card does not show every later card as changed', () => {
    const before = [home([card(1, 'Alpha'), card(2, 'Beta')])];
    const after = [home([card(3, 'New card'), card(1, 'Alpha'), card(2, 'Beta')])];

    const changes = run(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      field: 'layouts[0].section_four.cards[0]',
      op: 'added',
      kind: 'block',
      before: null,
      after: {
        title: 'New card',
        image: 'card-3.png',
        link: { label: 'More', url: '/c/3' },
        author: 'Ann',
      },
    });
  });

  it('reports removed and moved blocks, with what the removed block contained', () => {
    const before = [home([card(1, 'Alpha')]), cta(1, 'Go'), cta(2, 'Stop')];
    const after = [cta(2, 'Stop'), home([card(1, 'Alpha')])];

    const changes = run(before, after);
    const byOp = (op: string) => changes.filter((change) => change.op === op);

    expect(byOp('removed')).toEqual([
      expect.objectContaining({
        field: 'layouts[1]',
        path: ['layouts #2 · CTA “Go”'],
        before: { block: 'CTA', label: 'Go' },
        after: null,
      }),
    ]);
    expect(byOp('moved')).toHaveLength(1);
    expect(byOp('moved')[0]).toMatchObject({ path: ['layouts #1 · CTA “Stop”'], before: 'Position 3', after: 'Position 1' });
    expect(byOp('changed')).toHaveLength(0);
  });

  it('treats the same id in two different block types as two different blocks', () => {
    const changes = run([cta(1, 'Go')], [{ __component: 'layouts.home-layout', id: 1, section_four: null }]);
    expect(changes.map((change) => change.op).sort()).toEqual(['added', 'removed']);
  });

  it('shows files by name and related entries by title, and redacts sensitive keys at any depth', () => {
    const before = [home([card(1, 'Alpha', { apiToken: 'old-secret' })])];
    const after = [
      home([
        card(1, 'Alpha', {
          image: { id: 99, name: 'swapped.png' },
          author: { documentId: 'auth2', name: 'Bob' },
          apiToken: 'new-secret',
        }),
      ]),
    ];

    const changes = run(before, after);
    const at = (suffix: string) => changes.find((change) => change.field.endsWith(suffix));

    expect(at('.image')).toMatchObject({ before: 'card-1.png', after: 'swapped.png' });
    expect(at('.author')).toMatchObject({ before: 'Ann', after: 'Bob' });
    expect(at('.apiToken')).toMatchObject({ kind: 'redacted' });
    expect(JSON.stringify(changes)).not.toContain('secret');
  });

  it('on create, lists each block with its content instead of one opaque value', () => {
    const changes = run(null, [home([card(1, 'Alpha')]), cta(1, 'Go')], 'create');

    expect(changes.map((change) => [change.path?.join(' › '), change.op])).toEqual([
      ['layouts #1 · Home layout', 'added'],
      ['layouts #2 · CTA “Go”', 'added'],
    ]);
    expect(changes[0].after).toMatchObject({
      block: 'Home layout',
      section_four: { heading: 'Why us', cards: [{ title: 'Alpha', link: { url: '/c/1' } }] },
    });
  });

  it('compares every field of two versions in compare mode (publish)', () => {
    const changes = diffDocument({
      mode: 'compare',
      before: { title: 'Live', layouts: [cta(1, 'Go')], updatedAt: 'a' },
      after: { title: 'Draft', layouts: [cta(1, 'Go now')], updatedAt: 'b' },
      attributes,
      isSensitive: sensitive,
      getComponent,
    });

    expect(changes.map((change) => change.field)).toEqual(['title', 'layouts[0].label']);
  });

  it('matches blocks by content in compare mode, because publishing gives every component a new id', () => {
    // Same page, as the live version (ids 1..) and the draft (ids 50..): Beta's link was edited,
    // the cards were swapped, a CTA's only field changed, and a new CTA was added at the end.
    const live = [
      { ...home([card(1, 'Alpha'), card(2, 'Beta')]), id: 1 },
      cta(1, 'Go'),
    ];
    const draft = [
      {
        ...home([card(52, 'Beta', { link: { id: 152, label: 'More', url: '/new' } }), card(51, 'Alpha')]),
        id: 50,
        section_four: {
          id: 55,
          heading: 'Why us',
          cards: [
            card(52, 'Beta', { image: { id: 12, name: 'card-2.png' }, link: { id: 152, label: 'More', url: '/new' } }),
            card(51, 'Alpha', { image: { id: 11, name: 'card-1.png' }, link: { id: 151, label: 'More', url: '/c/1' } }),
          ],
        },
      },
      cta(50, 'Go now'),
      cta(51, 'Brand new'),
    ];

    const changes = diffDocument({
      mode: 'compare',
      before: { layouts: live },
      after: { layouts: draft },
      attributes,
      isSensitive: sensitive,
      getComponent,
    });

    expect(changes.map((change) => [change.field, change.op])).toEqual([
      ['layouts[0].section_four.cards[0]', 'moved'],
      ['layouts[0].section_four.cards[0].link.url', 'changed'],
      ['layouts[1].label', 'changed'],
      ['layouts[2]', 'added'],
    ]);
  });

  it('caps the number of changes and counts what it left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => card(i + 1, `Card ${i}`));
    const renamed = many.map((item) => ({ ...item, title: `${item.title}!` }));

    const result = diffDocumentDetailed({
      mode: 'update',
      data: { layouts: [] },
      before: { layouts: [home(many)] },
      after: { layouts: [home(renamed)] },
      attributes,
      isSensitive: sensitive,
      getComponent,
      maxChanges: 10,
    });

    expect(result.changes).toHaveLength(10);
    expect(result.omitted).toBe(20);
  });

  it('builds a populate tree that reaches the bottom of every block', () => {
    const models = {
      component: getComponent,
      contentType: () => ({ attributes: { name: { type: 'string' } } }),
    };
    const populate = buildPopulate(attributes, models) as any;
    const card = populate.layouts.on['layouts.home-layout'].populate.section_four.populate.cards.populate;

    expect(card.image).toEqual({ fields: ['name'] });
    expect(card.author).toEqual({ fields: ['documentId', 'name'] });
    expect(card.link).toBe(true);
    expect(populate.layouts.on['layouts.cta']).toBe(true);
    expect(populate.title).toBeUndefined();

    // The same tree for strapi.db.query(), which takes `select` and needs the id selected.
    const forQuery = buildPopulate(attributes, models, undefined, 0, 'query') as any;
    const queryCard = forQuery.layouts.on['layouts.home-layout'].populate.section_four.populate.cards.populate;
    expect(queryCard.image).toEqual({ select: ['id', 'name'] });
    expect(queryCard.author).toEqual({ select: ['id', 'documentId', 'name'] });
  });

  it('turns Strapi blocks rich text into readable text', () => {
    expect(
      blocksToText([
        { type: 'paragraph', children: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', bold: true }] },
        { type: 'list', children: [{ type: 'list-item', children: [{ type: 'text', text: 'one' }] }] },
      ])
    ).toBe('Hello world\n• one');
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

  const entry = (changes: AuditRow['changes']) => ({
    action: 'entry.update',
    category: 'content' as const,
    outcome: 'success' as const,
    actor: { type: 'admin' as const, id: '1' },
    changes: changes ?? undefined,
    occurredAt: new Date(),
  });

  it('redacts a configured field wherever it sits in a nested path', () => {
    const row = toRow(
      entry([{ field: 'layouts[2].contact.nationalId', path: ['layouts #3', 'contact', 'nationalId'], op: 'changed', before: '1', after: '2' }]),
      ['nationalId']
    );
    expect(row.changes).toEqual([
      { field: 'layouts[2].contact.nationalId', path: ['layouts #3', 'contact', 'nationalId'], op: 'changed', kind: 'redacted' },
    ]);
  });

  it('keeps every change path but drops values past the size budget', () => {
    const big = 'x'.repeat(1_900);
    const changes = Array.from({ length: 150 }, (_, i) => ({
      field: `layouts[${i}]`,
      op: 'added' as const,
      kind: 'block' as const,
      after: { a: big, b: big },
    }));

    const row = toRow(entry(changes));
    expect(row.changes).toHaveLength(150);
    expect(row.changes?.[0].after).toBeDefined();
    expect(row.changes?.[149]).toEqual({ field: 'layouts[149]', op: 'added', kind: 'block', truncated: true });
    expect(JSON.stringify(row.changes).length).toBeLessThan(300_000);
  });
});
