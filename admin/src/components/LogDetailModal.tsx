import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Loader,
  Modal,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { Lock, Shield, WarningCircle } from '@strapi/icons';
import styled from 'styled-components';
import { api, type FieldChange, type Integrity, type LogEntry } from '../utils/api';
import {
  ACTOR_TYPE_LABELS,
  actionLabel,
  actorLabel,
  CATEGORY_LABELS,
  formatDateTime,
  formatValue,
} from '../utils/format';

/**
 * Values are rendered as text inside <pre>, never as HTML. Entry content is attacker-
 * controllable (anyone with write access can put markup in a title), so the log viewer must
 * not become a stored-XSS sink.
 */
const Value = styled.pre`
  margin: 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 1.2rem;
  color: ${({ theme }) => theme.colors.neutral800};
`;

const INTEGRITY: Record<Integrity, { label: string; text: string; bg: string; fg: string }> = {
  valid: {
    label: 'Signature valid',
    text: 'This entry has not been changed since it was recorded.',
    bg: 'success100',
    fg: 'success700',
  },
  invalid: {
    label: 'Signature mismatch',
    text: 'This entry was changed after it was recorded, or was not written by this plugin. Treat its contents as untrusted.',
    bg: 'danger100',
    fg: 'danger700',
  },
  unsigned: {
    label: 'Not signed',
    text: 'No signing key was available when this entry was written.',
    bg: 'neutral150',
    fg: 'neutral700',
  },
  unverifiable: {
    label: 'Cannot verify',
    text: 'This entry is signed, but this server has no signing key to check it with.',
    bg: 'warning100',
    fg: 'warning700',
  },
};

const Meta = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="sigma" textColor="neutral600">
      {label}
    </Typography>
    <Typography textColor="neutral800" style={{ wordBreak: 'break-word' }}>
      {children}
    </Typography>
  </Flex>
);

const ChangeValue = ({ change, side }: { change: FieldChange; side: 'before' | 'after' }) => {
  if (change.kind === 'redacted') {
    return (
      <Flex gap={1} alignItems="center">
        <Lock width="1.2rem" height="1.2rem" />
        <Typography variant="pi" textColor="neutral600">Hidden</Typography>
      </Flex>
    );
  }
  if (change.kind === 'reference' && side === 'before') {
    return <Typography variant="pi" textColor="neutral500">Not recorded for relations</Typography>;
  }
  return <Value>{formatValue(change[side])}</Value>;
};

export const LogDetailModal = ({ id, onClose }: { id: number; onClose(): void }) => {
  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setError(null);
    api
      .log(id)
      .then((value) => !cancelled && setEntry(value))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const integrity = entry ? INTEGRITY[entry.integrity] : null;
  const details = entry?.details ? { ...entry.details } : null;

  return (
    <Modal.Root open onOpenChange={(open: boolean) => (!open ? onClose() : undefined)}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{entry ? `${actionLabel(entry.action)} · #${entry.id}` : 'Audit entry'}</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          {error && (
            <Alert variant="danger" closeLabel="Close" title="Could not load this entry">
              {error}
            </Alert>
          )}

          {!entry && !error && (
            <Flex justifyContent="center" padding={8}>
              <Loader>Loading entry…</Loader>
            </Flex>
          )}

          {entry && integrity && (
            <Flex direction="column" alignItems="stretch" gap={6}>
              <Box background={integrity.bg} padding={3} hasRadius>
                <Flex gap={2} alignItems="center">
                  <Box color={integrity.fg}>
                    {entry.integrity === 'valid' ? <Shield /> : <WarningCircle />}
                  </Box>
                  <Flex direction="column" alignItems="flex-start">
                    <Typography fontWeight="bold" textColor={integrity.fg}>
                      {integrity.label}
                    </Typography>
                    <Typography variant="pi" textColor={integrity.fg}>
                      {integrity.text}
                    </Typography>
                  </Flex>
                </Flex>
              </Box>

              <Grid.Root gap={5}>
                <Grid.Item col={6} s={12}>
                  <Meta label="When">{formatDateTime(entry.occurredAt)}</Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Result">
                    {entry.outcome === 'success' ? (
                      <Badge backgroundColor="success100" textColor="success700">Succeeded</Badge>
                    ) : (
                      <Badge backgroundColor="danger100" textColor="danger700">Failed</Badge>
                    )}
                  </Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Who">
                    {`${actorLabel(entry)}${entry.actorEmail && entry.actorName ? ` (${entry.actorEmail})` : ''} · ${
                      ACTOR_TYPE_LABELS[entry.actorType]
                    }`}
                  </Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Area">{`${CATEGORY_LABELS[entry.category]} · ${entry.action}`}</Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Item">
                    {[entry.targetLabel, entry.targetId && entry.targetId !== entry.targetLabel ? entry.targetId : null]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Type">{[entry.targetUid, entry.localeCode].filter(Boolean).join(' · ') || '—'}</Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="IP address">{entry.ipAddress ?? '—'}</Meta>
                </Grid.Item>
                <Grid.Item col={6} s={12}>
                  <Meta label="Request">
                    {[entry.requestMethod, entry.requestPath].filter(Boolean).join(' ') || '—'}
                  </Meta>
                </Grid.Item>
                <Grid.Item col={12}>
                  <Meta label="Browser">{entry.userAgent ?? '—'}</Meta>
                </Grid.Item>
              </Grid.Root>

              <Flex direction="column" alignItems="stretch" gap={3}>
                <Typography variant="delta" tag="h3">
                  {`Changes${entry.changes?.length ? ` (${entry.changes.length})` : ''}`}
                </Typography>
                {entry.changes && entry.changes.length > 0 ? (
                  <Table colCount={3} rowCount={entry.changes.length + 1}>
                    <Thead>
                      <Tr>
                        <Th><Typography variant="sigma">Field</Typography></Th>
                        <Th><Typography variant="sigma">Before</Typography></Th>
                        <Th><Typography variant="sigma">After</Typography></Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {entry.changes.map((change) => (
                        <Tr key={change.field}>
                          <Td style={{ verticalAlign: 'top' }}>
                            <Typography fontWeight="semiBold">{change.field}</Typography>
                          </Td>
                          <Td style={{ verticalAlign: 'top', maxWidth: 320 }}>
                            <ChangeValue change={change} side="before" />
                          </Td>
                          <Td style={{ verticalAlign: 'top', maxWidth: 320 }}>
                            <ChangeValue change={change} side="after" />
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                ) : (
                  <Typography textColor="neutral600">
                    {details?.unchanged ? 'Saved with no changes.' : 'No field-level changes recorded for this action.'}
                  </Typography>
                )}
              </Flex>

              {details && Object.keys(details).length > 0 && (
                <Flex direction="column" alignItems="stretch" gap={3}>
                  <Typography variant="delta" tag="h3">Details</Typography>
                  <Box background="neutral100" padding={3} hasRadius>
                    <Value>{JSON.stringify(details, null, 2)}</Value>
                  </Box>
                </Flex>
              )}
            </Flex>
          )}
        </Modal.Body>

        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">Close</Button>
          </Modal.Close>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};
