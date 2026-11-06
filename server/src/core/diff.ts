import { LIMITS, REDACTED } from '../constants';
import { LABEL_FIELDS } from './labels';
import { redactValue, type SensitiveKeyMatcher } from './redact';
import type { ChangeOp, FieldChange } from './types';

/** Columns Strapi manages itself. A change to them is never what the editor did. */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
]);

export interface AttributeInfo {
  type: string;
  component?: string;
  components?: string[];
  repeatable?: boolean;
  multiple?: boolean;
  relation?: string;
  target?: string;
  [key: string]: unknown;
}

export interface SchemaInfo {
  attributes: Record<string, AttributeInfo>;
  displayName?: string;
}

/** Looks up a component's schema by uid. Without it, components are compared as whole values. */
export type SchemaLookup = (uid: string) => SchemaInfo | undefined;

export interface DiffInput {
  /**
   * - `create`: everything in `data` is new; `before` is ignored.
   * - `update`: only the fields in `data` are compared, because that is what the save sent.
   * - `compare`: two stored versions (draft and published) are compared across every field.
   */
  mode: 'create' | 'update' | 'compare';
  /** The `data` the caller passed. For `create` and `update`, only these fields are considered. */
  data?: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  attributes: Record<string, AttributeInfo>;
  isSensitive: SensitiveKeyMatcher;
  getComponent?: SchemaLookup;
  /** Upper bound on the number of changes returned. Defaults to `LIMITS.maxChangesPerEntry`. */
  maxChanges?: number;
}

export interface DiffResult {
  changes: FieldChange[];
  /** Changes found beyond `maxChanges` and left out. */
  omitted: number;
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalise = (current: unknown): unknown => {
    if (current === undefined) return null;
    if (current instanceof Date) return current.toISOString();
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[circular]';
    seen.add(current);

    if (Array.isArray(current)) return current.map(normalise);

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      sorted[key] = normalise((current as Record<string, unknown>)[key]);
    }
    return sorted;
  };

  return JSON.stringify(normalise(value));
}

/** Component ids and editor scratch keys change without meaning anything to an editor. */
const VOLATILE_KEYS = new Set(['id', '__temp_key__', '__component_id']);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(key)) continue;
    output[key] = stripVolatile(child);
  }
  return output;
}

const MAX_RELATION_IDS = 20;

function relationIds(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];

  return list.slice(0, MAX_RELATION_IDS).map((item) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return record.documentId ?? record.id ?? null;
    }
    return item;
  });
}

/**
 * Describes a relation write without loading the related entries.
 *
 * The Content Manager sends `{ connect, disconnect }`; the API also accepts `set`, a bare array
 * or a single id. An empty connect/disconnect pair is what the editor sends when the relation
 * was not touched, and is not a change.
 */
export function summariseRelationWrite(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (value === null) return { set: [] };

  if (Array.isArray(value)) return { set: relationIds(value), count: value.length };

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const summary: Record<string, unknown> = {};

    for (const key of ['connect', 'disconnect', 'set'] as const) {
      const list = record[key];
      if (Array.isArray(list) && (list.length > 0 || key === 'set')) {
        summary[key] = relationIds(list);
        summary[`${key}Count`] = list.length;
      }
    }

    return Object.keys(summary).length > 0 ? summary : null;
  }

  return { set: [value] };
}

// --- Values ---------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** Empty in the sense an editor means: nothing filled in. `0` and `false` are values. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isEmpty(value) ? [] : [value];
}

const MAX_LABEL_CHARS = 60;

function shorten(text: string, max = MAX_LABEL_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** The name a person would know a component item or related entry by, if it has one. */
function itemLabel(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of LABEL_FIELDS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return shorten(value);
  }
  return undefined;
}

function fileName(file: unknown): string | null {
  if (file === null || file === undefined) return null;
  if (!isRecord(file)) return String(file);
  if (typeof file.name === 'string' && file.name.length > 0) return file.name;
  return file.id !== undefined ? `File #${String(file.id)}` : null;
}

function fileKey(file: unknown): unknown {
  return isRecord(file) ? (file.id ?? file.documentId ?? null) : (file ?? null);
}

function relationLabel(entry: unknown): string | null {
  if (entry === null || entry === undefined) return null;
  if (!isRecord(entry)) return String(entry);
  return itemLabel(entry) ?? (typeof entry.documentId === 'string' ? entry.documentId : `#${String(entry.id)}`);
}

function relationKey(entry: unknown): unknown {
  return isRecord(entry) ? (entry.documentId ?? entry.id ?? null) : (entry ?? null);
}

/** Plain text of a Strapi "blocks" rich-text value, so the log shows words rather than JSON. */
export function blocksToText(value: unknown): string {
  const lines: string[] = [];

  const inline = (node: unknown): string => {
    if (!isRecord(node)) return '';
    if (typeof node.text === 'string') return node.text;
    return Array.isArray(node.children) ? node.children.map(inline).join('') : '';
  };

  const walk = (node: unknown) => {
    if (!isRecord(node)) return;
    if (node.type === 'list' && Array.isArray(node.children)) {
      for (const child of node.children) lines.push(`• ${inline(child)}`);
      return;
    }
    if (node.type === 'image') {
      lines.push(`[image ${fileName(node.image) ?? ''}]`.trim());
      return;
    }
    lines.push(inline(node));
  };

  if (Array.isArray(value)) value.forEach(walk);
  return lines.join('\n').trim();
}

/** What two values are compared by. Equal keys mean "no change". */
function compareKey(attribute: AttributeInfo, value: unknown): string {
  if (isEmpty(value)) return 'null';

  switch (attribute.type) {
    case 'media':
      return stableStringify(asList(value).map(fileKey));
    case 'relation':
      return stableStringify(asList(value).map(relationKey));
    case 'component':
    case 'dynamiczone':
      return stableStringify(stripVolatile(value));
    default:
      return stableStringify(value);
  }
}

/** A stored value as a person should read it in the log. */
function displayValue(attribute: AttributeInfo, value: unknown): unknown {
  if (isEmpty(value)) return null;

  switch (attribute.type) {
    case 'media':
      return Array.isArray(value) ? value.map(fileName) : fileName(value);
    case 'relation':
      return Array.isArray(value) ? value.map(relationLabel) : relationLabel(value);
    case 'blocks':
      return blocksToText(value);
    case 'component':
    case 'dynamiczone':
      return stripVolatile(value);
    default:
      return value instanceof Date ? value.toISOString() : value;
  }
}

// --- Walker ---------------------------------------------------------------------------------

interface Location {
  field: string;
  path: string[];
}

const childLocation = (parent: Location, key: string): Location => ({
  field: parent.field ? `${parent.field}.${key}` : key,
  path: [...parent.path, key],
});

const MAX_DEPTH = 20;

class Walker {
  readonly changes: FieldChange[] = [];
  omitted = 0;

  constructor(
    private readonly isSensitive: SensitiveKeyMatcher,
    private readonly getComponent: SchemaLookup | undefined,
    private readonly max: number,
    /** Match list items by content instead of id: two stored versions never share component ids. */
    private readonly matchByContent = false
  ) {}

  private push(change: FieldChange) {
    if (this.changes.length >= this.max) {
      this.omitted += 1;
      return;
    }
    this.changes.push(change);
  }

  private schema(uid: string | undefined): SchemaInfo | undefined {
    return uid && this.getComponent ? this.getComponent(uid) : undefined;
  }

  /** The component's display name, as the Content Manager shows it on a dynamic zone block. */
  private componentName(uid: string | undefined): string {
    return this.schema(uid)?.displayName ?? uid ?? 'Block';
  }

  fields(
    attributes: Record<string, AttributeInfo>,
    keys: readonly string[],
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    at: Location,
    depth: number
  ) {
    for (const key of keys) {
      const attribute = attributes[key];
      if (!attribute) continue;
      this.attribute(attribute, before?.[key], after?.[key], childLocation(at, key), key, depth);
    }
  }

  attribute(attribute: AttributeInfo, before: unknown, after: unknown, at: Location, key: string, depth: number) {
    if (attribute.type === 'password' || this.isSensitive(key)) {
      if (compareKey(attribute, before) !== compareKey(attribute, after)) {
        this.push({ field: at.field, path: at.path, op: 'changed', kind: 'redacted' });
      }
      return;
    }

    if (depth < MAX_DEPTH && attribute.type === 'component' && this.schema(attribute.component)) {
      if (attribute.repeatable) this.list(attribute, before, after, at, depth);
      else this.single(attribute.component as string, before, after, at, depth);
      return;
    }

    if (depth < MAX_DEPTH && attribute.type === 'dynamiczone' && this.getComponent) {
      this.list(attribute, before, after, at, depth);
      return;
    }

    if (compareKey(attribute, before) === compareKey(attribute, after)) return;

    const op: ChangeOp = isEmpty(before) ? 'added' : isEmpty(after) ? 'removed' : 'changed';
    this.push({
      field: at.field,
      path: at.path,
      op,
      kind: 'value',
      before: displayValue(attribute, before),
      after: displayValue(attribute, after),
    });
  }

  /** A non-repeatable component: added, removed, or compared field by field. */
  private single(uid: string, before: unknown, after: unknown, at: Location, depth: number) {
    const schema = this.schema(uid) as SchemaInfo;
    const hadBefore = isRecord(before);
    const hasAfter = isRecord(after);

    if (!hadBefore && !hasAfter) return;

    if (!hadBefore || !hasAfter) {
      const snapshot = this.snapshot(schema, hadBefore ? before : after, depth);
      if (snapshot === null) return; // an empty component appearing or vanishing is not a change
      this.push({
        field: at.field,
        path: at.path,
        op: hadBefore ? 'removed' : 'added',
        kind: 'block',
        before: hadBefore ? snapshot : null,
        after: hadBefore ? null : snapshot,
      });
      return;
    }

    this.fields(schema.attributes, Object.keys(schema.attributes), before, after, at, depth + 1);
  }

  /**
   * A repeatable component or a dynamic zone.
   *
   * Items are matched by id (and component type, for a dynamic zone): Strapi keeps an item's id
   * when it is saved again, and the Content Manager sends it back with the form. An item only in
   * the new list was added, one only in the old list was removed, and a matched item whose
   * position changed relative to the others was moved. Matched items are then compared field by
   * field, so an edit deep inside a block is reported at its own path.
   */
  private list(attribute: AttributeInfo, before: unknown, after: unknown, at: Location, depth: number) {
    const isZone = attribute.type === 'dynamiczone';
    const oldItems = asList(before);
    const newItems = asList(after);
    const uidOf = (item: unknown) =>
      isZone ? (isRecord(item) && typeof item.__component === 'string' ? item.__component : undefined) : attribute.component;
    const keyOf = (item: unknown) =>
      isRecord(item) && item.id !== undefined && item.id !== null ? `${uidOf(item) ?? ''}:${String(item.id)}` : null;

    const oldIndex = new Map<string, number>();
    oldItems.forEach((item, index) => {
      const key = keyOf(item);
      if (key) oldIndex.set(key, index);
    });

    // Positions in the old list of the items kept, in their new order. The longest increasing
    // run of those positions stayed put; every other kept item was moved past it.
    let kept: { newAt: number; oldAt: number }[] = [];
    if (!this.matchByContent) {
      newItems.forEach((item, newAt) => {
        const key = keyOf(item);
        if (key && oldIndex.has(key)) kept.push({ newAt, oldAt: oldIndex.get(key) as number });
      });
    } else {
      kept = this.pairByContent(oldItems, newItems, uidOf);
    }
    const stayed = longestIncreasing(kept.map((entry) => entry.oldAt));
    const moved = new Set(kept.filter((_, i) => !stayed.has(i)).map((entry) => entry.newAt));
    const matchedOld = new Map(kept.map((entry) => [entry.newAt, entry.oldAt]));
    const usedOld = new Set(kept.map((entry) => entry.oldAt));

    const segment = (item: unknown, index: number) => {
      const name = at.path[at.path.length - 1] ?? 'item';
      const parts = [`${name} #${index + 1}`];
      if (isZone) parts.push(`· ${this.componentName(uidOf(item))}`);
      const label = itemLabel(item);
      if (label) parts.push(`“${label}”`);
      return parts.join(' ');
    };
    const itemLocation = (item: unknown, index: number): Location => ({
      field: `${at.field}[${index}]`,
      path: [...at.path.slice(0, -1), segment(item, index)],
    });

    newItems.forEach((item, newAt) => {
      const uid = uidOf(item);
      const schema = this.schema(uid);
      const location = itemLocation(item, newAt);
      const oldAt = matchedOld.get(newAt);

      if (oldAt === undefined) {
        this.push({
          field: location.field,
          path: location.path,
          op: 'added',
          kind: 'block',
          before: null,
          after: schema ? this.snapshot(schema, item, depth, isZone ? uid : undefined) : stripVolatile(item),
        });
        return;
      }

      if (moved.has(newAt)) {
        this.push({
          field: location.field,
          path: location.path,
          op: 'moved',
          kind: 'block',
          before: `Position ${oldAt + 1}`,
          after: `Position ${newAt + 1}`,
        });
      }

      const previous = oldItems[oldAt];
      if (schema) {
        this.fields(
          schema.attributes,
          Object.keys(schema.attributes),
          isRecord(previous) ? previous : null,
          isRecord(item) ? item : null,
          location,
          depth + 1
        );
      } else if (stableStringify(stripVolatile(previous)) !== stableStringify(stripVolatile(item))) {
        this.push({
          field: location.field,
          path: location.path,
          op: 'changed',
          kind: 'value',
          before: stripVolatile(previous),
          after: stripVolatile(item),
        });
      }
    });

    oldItems.forEach((item, oldAt) => {
      if (usedOld.has(oldAt)) return;
      const uid = uidOf(item);
      const schema = this.schema(uid);
      const location = itemLocation(item, oldAt);
      this.push({
        field: location.field,
        path: location.path,
        op: 'removed',
        kind: 'block',
        before: schema ? this.snapshot(schema, item, depth, isZone ? uid : undefined) : stripVolatile(item),
        after: null,
      });
    });
  }

  /**
   * How alike two items of the same component are: the share of their filled-in fields that hold
   * the same value, plus one if they carry the same title or label. Ids are ignored.
   */
  private similarity(uid: string | undefined, a: unknown, b: unknown): number {
    if (!isRecord(a) || !isRecord(b)) return 0;
    const label = itemLabel(a);
    return this.overlap(uid, a, b, 0) + (label !== undefined && label === itemLabel(b) ? 1 : 0);
  }

  /**
   * Share (0 to 1) of the filled-in fields two items have in common. A nested component counts
   * by its own overlap, so a large block with one edit deep inside still scores close to 1.
   */
  private overlap(uid: string | undefined, a: Record<string, unknown>, b: Record<string, unknown>, depth: number): number {
    const schema = this.schema(uid);
    if (!schema) return stableStringify(stripVolatile(a)) === stableStringify(stripVolatile(b)) ? 1 : 0;

    let equal = 0;
    let total = 0;
    for (const [key, attribute] of Object.entries(schema.attributes)) {
      const left = a[key];
      const right = b[key];
      if (isEmpty(left) && isEmpty(right)) continue;
      total += 1;
      if (
        attribute.type === 'component' &&
        !attribute.repeatable &&
        depth < MAX_DEPTH &&
        isRecord(left) &&
        isRecord(right)
      ) {
        equal += this.overlap(attribute.component, left, right, depth + 1);
      } else if (compareKey(attribute, left) === compareKey(attribute, right)) {
        equal += 1;
      }
    }
    return total === 0 ? 1 : equal / total;
  }

  /**
   * Pairs up the items of two versions of a list that share no ids.
   *
   * Publishing copies every component into new rows, so the draft and the live version of the
   * same card have different ids. Items are paired instead with the most alike item of the same
   * type, nearest position first on a tie. Pairs less than half alike are left unpaired, and
   * reported as one removed and one added rather than as an edit that rewrote everything.
   */
  private pairByContent(
    oldItems: unknown[],
    newItems: unknown[],
    uidOf: (item: unknown) => string | undefined
  ): { newAt: number; oldAt: number }[] {
    const candidates: { newAt: number; oldAt: number; score: number }[] = [];
    newItems.forEach((item, newAt) => {
      oldItems.forEach((previous, oldAt) => {
        if (uidOf(item) !== uidOf(previous)) return;
        const score = this.similarity(uidOf(item), previous, item);
        if (score >= 0.5) candidates.push({ newAt, oldAt, score });
      });
    });
    candidates.sort((x, y) => y.score - x.score || Math.abs(x.newAt - x.oldAt) - Math.abs(y.newAt - y.oldAt));

    const usedNew = new Set<number>();
    const usedOld = new Set<number>();
    const pairs: { newAt: number; oldAt: number }[] = [];
    for (const candidate of candidates) {
      if (usedNew.has(candidate.newAt) || usedOld.has(candidate.oldAt)) continue;
      usedNew.add(candidate.newAt);
      usedOld.add(candidate.oldAt);
      pairs.push({ newAt: candidate.newAt, oldAt: candidate.oldAt });
    }

    // Second pass: an item left over on each side, of the same type and in the same gap between
    // paired items, is the same item edited past recognition (a one-field CTA whose label
    // changed). Pairing them in order keeps the result free of invented moves.
    newItems.forEach((item, newAt) => {
      if (usedNew.has(newAt)) return;
      const lower = Math.max(-1, ...pairs.filter((pair) => pair.newAt < newAt).map((pair) => pair.oldAt));
      const upper = Math.min(oldItems.length, ...pairs.filter((pair) => pair.newAt > newAt).map((pair) => pair.oldAt));
      for (let oldAt = lower + 1; oldAt < upper; oldAt += 1) {
        if (usedOld.has(oldAt) || uidOf(oldItems[oldAt]) !== uidOf(item)) continue;
        usedNew.add(newAt);
        usedOld.add(oldAt);
        pairs.push({ newAt, oldAt });
        break;
      }
    });

    return pairs.sort((x, y) => x.newAt - y.newAt);
  }

  /**
   * A readable copy of a component's content: empty fields left out, ids dropped, files shown by
   * name and related entries by their title. Returns null when nothing in it is filled in.
   */
  snapshot(schema: SchemaInfo, value: unknown, depth: number, zoneUid?: string): Record<string, unknown> | null {
    if (!isRecord(value)) return null;

    const output: Record<string, unknown> = {};
    if (zoneUid) output.block = this.componentName(zoneUid);

    for (const [key, attribute] of Object.entries(schema.attributes)) {
      const child = value[key];
      if (isEmpty(child)) continue;

      if (attribute.type === 'password' || this.isSensitive(key)) {
        output[key] = REDACTED;
        continue;
      }

      const nested = depth < MAX_DEPTH ? this.schema(attribute.component) : undefined;
      if (attribute.type === 'component' && nested) {
        if (attribute.repeatable) {
          const items = asList(child)
            .map((item) => this.snapshot(nested, item, depth + 1))
            .filter((item) => item !== null);
          if (items.length > 0) output[key] = items;
        } else {
          const inner = this.snapshot(nested, child, depth + 1);
          if (inner !== null) output[key] = inner;
        }
        continue;
      }

      if (attribute.type === 'dynamiczone' && depth < MAX_DEPTH && this.getComponent) {
        const blocks = asList(child)
          .map((item) => {
            const uid = isRecord(item) && typeof item.__component === 'string' ? item.__component : undefined;
            const blockSchema = this.schema(uid);
            return blockSchema ? this.snapshot(blockSchema, item, depth + 1, uid) : stripVolatile(item);
          })
          .filter((item) => item !== null);
        if (blocks.length > 0) output[key] = blocks;
        continue;
      }

      output[key] = displayValue(attribute, child);
    }

    const filled = Object.keys(output).filter((key) => key !== 'block');
    return filled.length > 0 || zoneUid ? output : null;
  }
}

/** Indexes (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);

  values.forEach((value, i) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  });

  const result = new Set<number>();
  let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (cursor !== -1) {
    result.add(cursor);
    cursor = previous[cursor];
  }
  return result;
}

/**
 * Lists what a write actually changed, at whatever depth it happened.
 *
 * The Content Manager sends the whole form on every save, so a field being present in `data`
 * says nothing about whether it changed. Each one is compared against the stored state, and
 * only real differences are kept. Components and dynamic zones are walked item by item, so an
 * edit to one card inside one block of a page is reported as that one field, not as the whole
 * zone before and after.
 */
export function diffDocumentDetailed(input: DiffInput): DiffResult {
  const walker = new Walker(
    input.isSensitive,
    input.getComponent,
    input.maxChanges ?? LIMITS.maxChangesPerEntry,
    input.mode === 'compare'
  );
  const root: Location = { field: '', path: [] };
  const before = input.mode === 'create' ? null : input.before;

  const keys =
    input.mode === 'compare' || !input.data
      ? Object.keys(input.attributes)
      : Object.keys(input.data);

  for (const field of keys) {
    if (SYSTEM_FIELDS.has(field)) continue;

    const attribute = input.attributes[field];
    if (!attribute) continue;

    const incoming = input.data?.[field];
    const at = childLocation(root, field);

    // A password is never loaded back, so "sent a non-empty value" is the only signal there is.
    if (input.mode !== 'compare' && (attribute.type === 'password' || input.isSensitive(field))) {
      if (incoming === undefined || incoming === null || incoming === '') continue;
      walker.changes.push({ field, path: at.path, op: 'changed', kind: 'redacted' });
      continue;
    }

    if (attribute.type === 'relation' && input.mode !== 'compare') {
      // An empty connect/disconnect pair is the editor not touching the relation.
      const summary = summariseRelationWrite(incoming);
      if (!summary) continue;

      const loaded =
        input.after && Object.prototype.hasOwnProperty.call(input.after, field) &&
        (input.mode === 'create' || (input.before && Object.prototype.hasOwnProperty.call(input.before, field)));
      if (!loaded) {
        walker.changes.push({ field, path: at.path, op: 'changed', kind: 'reference', after: summary });
        continue;
      }
    }

    const afterValue =
      input.after && Object.prototype.hasOwnProperty.call(input.after, field) ? input.after[field] : incoming;

    walker.attribute(attribute, before?.[field], afterValue, at, field, 0);
  }

  return {
    changes: walker.changes.map((change) => ({
      ...change,
      ...(change.before !== undefined ? { before: redactValue(change.before, input.isSensitive) } : {}),
      ...(change.after !== undefined ? { after: redactValue(change.after, input.isSensitive) } : {}),
    })),
    omitted: walker.omitted,
  };
}

export function diffDocument(input: DiffInput): FieldChange[] {
  return diffDocumentDetailed(input).changes;
}

// --- Populate -------------------------------------------------------------------------------

export interface ModelLookup {
  component(uid: string): SchemaInfo | undefined;
  contentType(uid: string): SchemaInfo | undefined;
}

const LABEL_TYPES = new Set(['string', 'text', 'uid', 'email', 'enumeration']);

function relationFields(target: SchemaInfo | undefined): string[] {
  const fields = ['documentId'];
  const label = LABEL_FIELDS.find((key) => LABEL_TYPES.has(target?.attributes[key]?.type ?? ''));
  if (label) fields.push(label);
  return fields;
}

/**
 * A populate tree that loads everything the diff needs: every component and dynamic zone block,
 * at every depth, with files reduced to their name and related entries to their title. Strapi
 * only goes one level deep with `populate: { field: true }`, which is why a nested change was
 * invisible before.
 *
 * `engine: 'query'` builds the same tree for `strapi.db.query()` (`select` rather than
 * `fields`). The query engine skips the Document Service's draft/published handling of every
 * populated relation, which on a page builder made the load six times slower for an identical
 * result.
 */
export function buildPopulate(
  attributes: Record<string, AttributeInfo>,
  models: ModelLookup,
  keys: readonly string[] = Object.keys(attributes),
  depth = 0,
  engine: 'document' | 'query' = 'document'
): Record<string, unknown> | undefined {
  const populate: Record<string, unknown> = {};
  const pick = (fields: string[]) => (engine === 'query' ? { select: ['id', ...fields] } : { fields });

  for (const key of keys) {
    if (SYSTEM_FIELDS.has(key) && depth === 0) continue;
    const attribute = attributes[key];
    if (!attribute) continue;

    switch (attribute.type) {
      case 'media':
        populate[key] = pick(['name']);
        break;
      case 'relation':
        if (typeof attribute.relation === 'string' && attribute.relation.startsWith('morph')) break;
        if (!attribute.target) break;
        populate[key] = pick(relationFields(models.contentType(attribute.target)));
        break;
      case 'component': {
        const schema = attribute.component ? models.component(attribute.component) : undefined;
        if (!schema) {
          populate[key] = true;
          break;
        }
        const inner =
          depth < MAX_DEPTH ? buildPopulate(schema.attributes, models, undefined, depth + 1, engine) : undefined;
        populate[key] = inner ? { populate: inner } : true;
        break;
      }
      case 'dynamiczone': {
        const on: Record<string, unknown> = {};
        for (const uid of attribute.components ?? []) {
          const schema = models.component(uid);
          const inner =
            schema && depth < MAX_DEPTH
              ? buildPopulate(schema.attributes, models, undefined, depth + 1, engine)
              : undefined;
          on[uid] = inner ? { populate: inner } : true;
        }
        populate[key] = Object.keys(on).length > 0 ? { on } : true;
        break;
      }
      default:
        break;
    }
  }

  return Object.keys(populate).length > 0 ? populate : undefined;
}
