import { describe, expect, it } from 'vitest';
import { diffRecord, durationLabel, maskUrl, type FieldSpec } from '../src/core/record-diff';

const webhook: FieldSpec[] = [
  { key: 'name', label: 'Name' },
  { key: 'url', label: 'URL' },
  { key: 'enabled', label: 'Enabled' },
  { key: 'events', label: 'Events', list: true },
  { key: 'headerValues', label: 'Header values', secret: true },
];

describe('diffRecord', () => {
  it('reports changed values, and only the list items added or removed', () => {
    const before = { name: 'Deploy', url: 'https://a.example/hook', enabled: true, events: ['entry.create', 'entry.update', 'entry.publish'], headerValues: 'aaa' };
    const after = { name: 'Deploy', url: 'https://b.example/hook', enabled: false, events: ['entry.create', 'entry.publish', 'media.create'], headerValues: 'bbb' };

    expect(diffRecord(webhook, before, after)).toEqual([
      { field: 'url', path: ['URL'], op: 'changed', kind: 'value', before: 'https://a.example/hook', after: 'https://b.example/hook' },
      { field: 'enabled', path: ['Enabled'], op: 'changed', kind: 'value', before: true, after: false },
      { field: 'events', path: ['Events'], op: 'removed', kind: 'value', before: ['entry.update'], after: null },
      { field: 'events', path: ['Events'], op: 'added', kind: 'value', before: null, after: ['media.create'] },
      { field: 'headerValues', path: ['Header values'], op: 'changed', kind: 'redacted' },
    ]);
  });

  it('lists every filled field on create and on delete, and never a secret value', () => {
    const row = { name: 'Deploy', url: 'https://a.example/hook', enabled: true, events: ['entry.create'], headerValues: 'fingerprint' };

    const created = diffRecord(webhook, null, row);
    expect(created.map((change) => [change.field, change.op])).toEqual([
      ['name', 'added'],
      ['url', 'added'],
      ['enabled', 'added'],
      ['events', 'added'],
      ['headerValues', 'added'],
    ]);
    expect(JSON.stringify(created)).not.toContain('fingerprint');

    expect(diffRecord(webhook, row, null).every((change) => change.op === 'removed')).toBe(true);
  });

  it('hides query string values and credentials in URLs', () => {
    expect(maskUrl('https://hooks.example.com/deploy?token=abc123&site=nrb')).toBe('https://hooks.example.com/deploy?token=•••&site=•••');
    expect(maskUrl('https://user:pass@hooks.example.com/x')).toBe('https://•••:•••@hooks.example.com/x');
    expect(maskUrl('not a url?secret=1')).toBe('not a url?•••');
  });

  it('describes token durations as the admin panel does', () => {
    expect(durationLabel(null)).toBe('Unlimited');
    expect(durationLabel(7 * 86_400_000)).toBe('7 days');
    expect(durationLabel(86_400_000)).toBe('1 day');
  });
});
