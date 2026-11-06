import { describe, expect, it } from 'vitest';
import {
  adminUserFields,
  diffAdminUser,
  diffPermissions,
  diffRole,
  type PermissionLabels,
} from '../src/core/admin-diff';

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  firstname: 'Nikita',
  lastname: 'Pant',
  email: 'nikita@example.com',
  username: null,
  isActive: true,
  blocked: false,
  preferedLanguage: null,
  roles: [{ id: 3, name: 'Editor' }],
  ...overrides,
});

describe('admin user diff', () => {
  it('shows role changes by name, and flags only the fields that changed', () => {
    const changes = diffAdminUser(user(), user({ roles: [{ id: 4, name: 'Author' }], isActive: false }), {
      roles: [4],
      isActive: false,
    });

    expect(changes).toEqual([
      { field: 'isActive', path: ['Active'], op: 'changed', kind: 'value', before: true, after: false },
      { field: 'roles', path: ['Roles'], op: 'changed', kind: 'value', before: ['Editor'], after: ['Author'] },
    ]);
  });

  it('ignores role order and reports a password change without its value', () => {
    const before = user({ roles: [{ id: 3, name: 'Editor' }, { id: 4, name: 'Author' }] });
    const after = user({ roles: [{ id: 4, name: 'Author' }, { id: 3, name: 'Editor' }] });

    const changes = diffAdminUser(before, after, { password: 'N3w-Secret!' });
    expect(changes).toEqual([{ field: 'password', path: ['Password'], op: 'changed', kind: 'redacted' }]);
    expect(JSON.stringify(changes)).not.toContain('N3w-Secret');
  });

  it('lists an invited or deleted user as added or removed fields', () => {
    const added = adminUserFields(user(), 'added');
    expect(added.map((change) => change.path?.[0])).toEqual(['First name', 'Last name', 'Email', 'Active', 'Blocked', 'Roles']);
    expect(added.find((change) => change.field === 'roles')).toMatchObject({ op: 'added', after: ['Editor'] });

    const removed = adminUserFields(user(), 'removed');
    expect(removed.every((change) => change.op === 'removed' && change.after === null)).toBe(true);
  });

  it('diffs a role name and description', () => {
    expect(diffRole({ name: 'Editor', description: 'a' }, { name: 'Senior editor', description: 'a' })).toEqual([
      { field: 'name', path: ['Name'], op: 'changed', kind: 'value', before: 'Editor', after: 'Senior editor' },
    ]);
  });
});

describe('role permission diff', () => {
  const labels: PermissionLabels = {
    group: (_action, subject) =>
      subject ? `Content › ${subject === 'api::page.page' ? 'Pages' : 'Article'}` : 'Settings › Media Library',
    action: (action) => ({ create: 'Create', read: 'Read', publish: 'Publish', 'assets.update': 'Update' })[action.split('.').pop() as string] ?? action,
    condition: (id) => (id === 'admin::is-creator' ? 'Is creator' : id),
  };
  const perm = (action: string, subject: string | null, fields?: string[], conditions: string[] = []) => ({
    action: `plugin::content-manager.explorer.${action}`,
    subject,
    properties: fields ? { fields } : {},
    conditions,
  });

  it('reports granted, revoked and narrowed permissions, grouped by what they apply to', () => {
    const before = [
      perm('create', 'api::page.page', ['title', 'slug', 'layouts']),
      perm('read', 'api::page.page', ['title', 'slug', 'layouts']),
      perm('publish', 'api::page.page'),
    ];
    const after = [
      perm('create', 'api::page.page', ['title', 'slug']),
      perm('read', 'api::page.page', ['title', 'slug', 'layouts'], ['admin::is-creator']),
      perm('create', 'api::article.article', ['title']),
    ];

    const changes = diffPermissions(before, after, labels);

    expect(changes.map((change) => [change.path?.join(' › '), change.op])).toEqual([
      ['Content › Article › Create', 'added'],
      ['Content › Pages › Create › Fields', 'removed'],
      ['Content › Pages › Publish', 'removed'],
      ['Content › Pages › Read › Conditions', 'added'],
    ]);
    expect(changes[0].after).toEqual({ Fields: ['title'] });
    // Only the unticked field, not the whole list before and after.
    expect(changes[1]).toMatchObject({ before: ['layouts'], after: null });
    expect(changes[2]).toMatchObject({ before: 'Allowed', after: null });
    expect(changes[3]).toMatchObject({ before: null, after: ['Is creator'] });
  });

  it('reports nothing when the same permissions are saved again in another order', () => {
    const set = [perm('create', 'api::page.page', ['title', 'slug']), perm('read', 'api::page.page')];
    const reordered = [perm('read', 'api::page.page'), perm('create', 'api::page.page', ['slug', 'title'])];
    expect(diffPermissions(set, reordered, labels)).toEqual([]);
  });
});
