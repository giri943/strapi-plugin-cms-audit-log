export interface DiffPart {
  text: string;
  /** `same` on both sides; `removed` only on the before side; `added` only on the after side. */
  type: 'same' | 'removed' | 'added';
}

const MAX_TOKENS = 1_500;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Whether a string is HTML markup (CKEditor and other rich-text fields store HTML). */
export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(value);
}

/**
 * The words in an HTML string, as text. Only used to decide and display what changed; the
 * markup is never rendered.
 */
export function htmlToText(value: string): string {
  return value
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function tokens(value: string): string[] {
  return value.split(/(\s+)/).filter((token) => token.length > 0);
}

/**
 * Word-level diff of two strings, for highlighting what was edited inside a long text.
 *
 * Returns null when the texts are too long to compare in the browser without stalling it; the
 * caller then shows both values whole.
 */
export function diffWords(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } | null {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  // Trim the shared start and end first: most edits touch a few words in a long text.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Uint16Array(rows * cols);

  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const left: DiffPart[] = [];
  const right: DiffPart[] = [];
  const push = (list: DiffPart[], text: string, type: DiffPart['type']) => {
    const last = list[list.length - 1];
    if (last && last.type === type) last.text += text;
    else list.push({ text, type });
  };

  const head = a.slice(0, start).join('');
  if (head) {
    push(left, head, 'same');
    push(right, head, 'same');
  }

  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      push(left, midA[i], 'same');
      push(right, midB[j], 'same');
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      push(left, midA[i], 'removed');
      i += 1;
    } else {
      push(right, midB[j], 'added');
      j += 1;
    }
  }
  for (; i < midA.length; i += 1) push(left, midA[i], 'removed');
  for (; j < midB.length; j += 1) push(right, midB[j], 'added');

  const tail = a.slice(endA).join('');
  if (tail) {
    push(left, tail, 'same');
    push(right, tail, 'same');
  }

  return { before: left, after: right };
}
