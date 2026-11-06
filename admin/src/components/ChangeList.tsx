import { Badge, Box, Flex, Typography } from '@strapi/design-system';
import { Lock } from '@strapi/icons';
import styled from 'styled-components';
import type { ChangeOp, FieldChange } from '../utils/api';
import { diffWords, htmlToText, looksLikeHtml, type DiffPart } from '../utils/text-diff';

/*
 * Everything here is rendered as text. Entry content is attacker-controllable (anyone with
 * write access can put markup in a title or a rich-text field), so the log viewer must never
 * become a stored-XSS sink: no dangerouslySetInnerHTML, HTML is reduced to its words.
 */

const Text = styled.div`
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 1.3rem;
  line-height: 1.5;
  color: ${({ theme }) => theme.colors.neutral800};
  max-height: 320px;
  overflow: auto;
`;

const Removed = styled.span`
  background: ${({ theme }) => theme.colors.danger100};
  color: ${({ theme }) => theme.colors.danger700};
  text-decoration: line-through;
  border-radius: 2px;
`;

const Added = styled.span`
  background: ${({ theme }) => theme.colors.success100};
  color: ${({ theme }) => theme.colors.success700};
  border-radius: 2px;
`;

const Group = styled.details`
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};

  & > summary {
    cursor: pointer;
    padding: ${({ theme }) => `${theme.spaces[3]} ${theme.spaces[4]}`};
    list-style-position: inside;
    background: ${({ theme }) => theme.colors.neutral100};
    border-radius: ${({ theme }) => theme.borderRadius};
  }
  &[open] > summary {
    border-bottom: 1px solid ${({ theme }) => theme.colors.neutral200};
    border-radius: ${({ theme }) => `${theme.borderRadius} ${theme.borderRadius} 0 0`};
  }
`;

const Tree = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: minmax(80px, max-content) 1fr;
  column-gap: ${({ theme }) => theme.spaces[3]};
  row-gap: ${({ theme }) => theme.spaces[1]};

  & > dt {
    font-size: 1.2rem;
    font-weight: 600;
    color: ${({ theme }) => theme.colors.neutral600};
    word-break: break-word;
  }
  & > dd {
    margin: 0;
    min-width: 0;
  }
`;

const Row = styled.div`
  padding: ${({ theme }) => theme.spaces[4]};
  & + & {
    border-top: 1px solid ${({ theme }) => theme.colors.neutral150};
  }
  details > summary + & {
    border-top: none;
  }
`;

const Single = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};
`;

const Nested = styled.div`
  border-left: 2px solid ${({ theme }) => theme.colors.neutral200};
  padding-left: ${({ theme }) => theme.spaces[3]};
`;

const OP_STYLE: Record<ChangeOp, { label: string; bg: string; fg: string }> = {
  changed: { label: 'Edited', bg: 'primary100', fg: 'primary700' },
  added: { label: 'Added', bg: 'success100', fg: 'success700' },
  removed: { label: 'Removed', bg: 'danger100', fg: 'danger700' },
  moved: { label: 'Moved', bg: 'warning100', fg: 'warning700' },
};

/** Rows from 0.1.0-beta.0 have neither `op` nor `path`; work them out from what is there. */
function opOf(change: FieldChange): ChangeOp {
  if (change.op) return change.op;
  if (change.kind === 'reference') return 'changed';
  if (change.before === null || change.before === undefined) return 'added';
  if (change.after === null || change.after === undefined) return 'removed';
  return 'changed';
}

function pathOf(change: FieldChange): string[] {
  return change.path && change.path.length > 0 ? change.path : [change.field];
}

const humanise = (key: string) => key.replace(/_/g, ' ');

const Muted = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="pi" textColor="neutral500">
    {children}
  </Typography>
);

function plain(value: string): { text: string; html: boolean } {
  return looksLikeHtml(value) ? { text: htmlToText(value), html: true } : { text: value, html: false };
}

const Highlighted = ({ parts }: { parts: DiffPart[] }) => (
  <Text>
    {parts.map((part, index) =>
      part.type === 'removed' ? (
        <Removed key={index}>{part.text}</Removed>
      ) : part.type === 'added' ? (
        <Added key={index}>{part.text}</Added>
      ) : (
        <span key={index}>{part.text}</span>
      )
    )}
  </Text>
);

/** Any stored value, as readable text and nested lists. */
const ValueView = ({ value, depth = 0 }: { value: unknown; depth?: number }) => {
  if (value === null || value === undefined) return <Muted>Empty</Muted>;
  if (typeof value === 'boolean') return <Text>{value ? 'Yes' : 'No'}</Text>;
  if (typeof value === 'number') return <Text>{String(value)}</Text>;

  if (typeof value === 'string') {
    if (value.length === 0) return <Muted>Empty</Muted>;
    const { text, html } = plain(value);
    return (
      <Flex direction="column" alignItems="stretch" gap={1}>
        <Text>{text || ' '}</Text>
        {html && <Muted>Rich text; formatting not shown</Muted>}
      </Flex>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Muted>Empty</Muted>;
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return <Text>{value.map((item) => `• ${item === null ? '—' : String(item)}`).join('\n')}</Text>;
    }
    return (
      <Flex direction="column" alignItems="stretch" gap={2}>
        {value.map((item, index) => (
          <Nested key={index}>
            <Typography variant="pi" fontWeight="bold" textColor="neutral700">
              {`#${index + 1}${item && typeof item === 'object' && 'block' in item ? ` · ${String((item as { block: unknown }).block)}` : ''}`}
            </Typography>
            <ValueView value={item} depth={depth + 1} />
          </Nested>
        ))}
      </Flex>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'block');
    if (entries.length === 0) return <Muted>Nothing filled in</Muted>;
    return (
      <Tree>
        {entries.map(([key, child]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt>{humanise(key)}</dt>
            <dd>
              {child && typeof child === 'object' ? (
                <Nested>
                  <ValueView value={child} depth={depth + 1} />
                </Nested>
              ) : (
                <ValueView value={child} depth={depth + 1} />
              )}
            </dd>
          </div>
        ))}
      </Tree>
    );
  }

  return <Text>{String(value)}</Text>;
};

/** A relation write from a row where the related entries could not be loaded. */
const ReferenceView = ({ value }: { value: unknown }) => {
  const record = (value ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const list = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]).map(String).join(', ') : '');
  if (record.connect) lines.push(`Linked: ${list('connect')}`);
  if (record.disconnect) lines.push(`Unlinked: ${list('disconnect')}`);
  if (record.set) lines.push(`Set to: ${list('set') || 'nothing'}`);
  return <Text>{lines.join('\n') || 'Relation changed'}</Text>;
};

const Column = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Box flex="1" minWidth={0} background="neutral100" padding={3} hasRadius>
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Typography variant="sigma" textColor="neutral600">
        {title}
      </Typography>
      {children}
    </Flex>
  </Box>
);

const ChangeBody = ({ change }: { change: FieldChange }) => {
  const op = opOf(change);

  if (change.kind === 'redacted') {
    return (
      <Flex gap={1} alignItems="center">
        <Lock width="1.2rem" height="1.2rem" />
        <Muted>Value hidden: this field holds sensitive data</Muted>
      </Flex>
    );
  }
  if (change.truncated) return <Muted>Value too large to store; only the location was recorded.</Muted>;
  if (change.kind === 'reference') return <ReferenceView value={change.after} />;

  if (op === 'moved') {
    return <Text>{`${String(change.before ?? '?')} → ${String(change.after ?? '?')}`}</Text>;
  }
  if (op === 'added') {
    return (
      <Column title={change.kind === 'block' ? 'Content added' : 'New value'}>
        <ValueView value={change.after} />
      </Column>
    );
  }
  if (op === 'removed') {
    return (
      <Column title={change.kind === 'block' ? 'Content removed' : 'Previous value'}>
        <ValueView value={change.before} />
      </Column>
    );
  }

  if (typeof change.before === 'string' && typeof change.after === 'string') {
    const before = plain(change.before);
    const after = plain(change.after);
    if (before.text === after.text && (before.html || after.html)) {
      return <Muted>Only the formatting of this rich text changed.</Muted>;
    }
    const parts = diffWords(before.text, after.text);
    if (parts) {
      return (
        <Flex gap={3} alignItems="stretch" wrap="wrap">
          <Column title="Before">
            <Highlighted parts={parts.before} />
          </Column>
          <Column title="After">
            <Highlighted parts={parts.after} />
          </Column>
        </Flex>
      );
    }
  }

  return (
    <Flex gap={3} alignItems="stretch" wrap="wrap">
      <Column title="Before">
        <ValueView value={change.before} />
      </Column>
      <Column title="After">
        <ValueView value={change.after} />
      </Column>
    </Flex>
  );
};

const OpBadge = ({ op }: { op: ChangeOp }) => (
  <Badge backgroundColor={OP_STYLE[op].bg} textColor={OP_STYLE[op].fg}>
    {OP_STYLE[op].label}
  </Badge>
);

const ChangeRow = ({ change, depthOffset }: { change: FieldChange; depthOffset: number }) => {
  const path = pathOf(change).slice(depthOffset);
  const op = opOf(change);
  const where = path.length > 0 ? path.map(humanise).join(' › ') : change.kind === 'block' ? 'Whole block' : 'Value';

  return (
    <Row>
      <Flex direction="column" alignItems="stretch" gap={2}>
        <Flex gap={2} alignItems="center" wrap="wrap">
          <OpBadge op={op} />
          <Typography fontWeight="semiBold" textColor="neutral800" style={{ wordBreak: 'break-word' }}>
            {where}
          </Typography>
        </Flex>
        <ChangeBody change={change} />
      </Flex>
    </Row>
  );
};

/** One line saying how much changed, e.g. "3 edited · 1 block added". */
export function changeSummary(changes: FieldChange[]): string {
  const counts: Record<ChangeOp, number> = { changed: 0, added: 0, removed: 0, moved: 0 };
  for (const change of changes) counts[opOf(change)] += 1;
  return (['changed', 'added', 'removed', 'moved'] as ChangeOp[])
    .filter((op) => counts[op] > 0)
    .map((op) => `${counts[op]} ${OP_STYLE[op].label.toLowerCase()}`)
    .join(' · ');
}

/**
 * The changes of one entry, grouped by where in the document they happened: one group per
 * top-level field or dynamic zone block, so an edit to one card inside one page section reads
 * as "layouts #2 · Home layout → section four › cards #3 › title".
 */
export const ChangeList = ({ changes }: { changes: FieldChange[] }) => {
  const groups = new Map<string, FieldChange[]>();
  for (const change of changes) {
    const key = pathOf(change)[0];
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      {[...groups.entries()].map(([name, items]) => {
        // A single change at the group's own level (a top-level field) needs no group header.
        if (items.length === 1 && pathOf(items[0]).length === 1) {
          return (
            <Single key={name}>
              <ChangeRow change={items[0]} depthOffset={0} />
            </Single>
          );
        }
        return (
          <Group key={name} open>
            <summary>
              <Typography fontWeight="bold" textColor="neutral800">
                {humanise(name)}
              </Typography>{' '}
              <Typography variant="pi" textColor="neutral600">
                {`(${changeSummary(items)})`}
              </Typography>
            </summary>
            {items.map((change, index) => (
              <ChangeRow key={`${change.field}-${index}`} change={change} depthOffset={1} />
            ))}
          </Group>
        );
      })}
    </Flex>
  );
};
