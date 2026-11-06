import {
  Badge,
  Box,
  Button,
  EmptyStateLayout,
  Flex,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { CheckCircle, CrossCircle, Eye } from '@strapi/icons';
import type { LogPage } from '../utils/api';
import { PAGE_SIZES } from '../utils/filters';
import {
  ACTOR_TYPE_LABELS,
  actionLabel,
  actorLabel,
  CATEGORY_LABELS,
  formatDateTime,
  formatNumber,
  formatRelative,
} from '../utils/format';

interface Props {
  page: LogPage;
  loading: boolean;
  onOpen(id: number): void;
  onPage(page: number): void;
  onPageSize(size: number): void;
}

const COLUMNS = 7;

export const LogTable = ({ page, loading, onOpen, onPage, onPageSize }: Props) => {
  const { results, pagination } = page;
  const first = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const last = Math.min(pagination.total, pagination.page * pagination.pageSize);

  if (!loading && results.length === 0) {
    return (
      <Box background="neutral0" hasRadius shadow="tableShadow">
        <EmptyStateLayout content="No activity matches these filters." />
      </Box>
    );
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Table colCount={COLUMNS} rowCount={results.length + 1}>
        <Thead>
          <Tr>
            <Th><Typography variant="sigma">When</Typography></Th>
            <Th><Typography variant="sigma">Who</Typography></Th>
            <Th><Typography variant="sigma">What</Typography></Th>
            <Th><Typography variant="sigma">Item</Typography></Th>
            <Th><Typography variant="sigma">Result</Typography></Th>
            <Th><Typography variant="sigma">IP address</Typography></Th>
            <Th><VisuallyHidden>Open</VisuallyHidden></Th>
          </Tr>
        </Thead>
        <Tbody>
          {results.map((row) => (
            <Tr key={row.id} onClick={() => onOpen(row.id)} style={{ cursor: 'pointer' }}>
              <Td>
                <Flex direction="column" alignItems="flex-start">
                  <Typography textColor="neutral800">{formatDateTime(row.occurredAt)}</Typography>
                  <Typography variant="pi" textColor="neutral500">{formatRelative(row.occurredAt)}</Typography>
                </Flex>
              </Td>
              <Td>
                <Flex direction="column" alignItems="flex-start" maxWidth="240px">
                  <Typography textColor="neutral800" ellipsis>{actorLabel(row)}</Typography>
                  <Typography variant="pi" textColor="neutral500" ellipsis>
                    {row.actorType === 'admin' ? (row.actorEmail ?? '') : ACTOR_TYPE_LABELS[row.actorType]}
                  </Typography>
                </Flex>
              </Td>
              <Td>
                <Flex direction="column" alignItems="flex-start">
                  <Typography textColor="neutral800">{actionLabel(row.action)}</Typography>
                  <Typography variant="pi" textColor="neutral500">{CATEGORY_LABELS[row.category]}</Typography>
                </Flex>
              </Td>
              <Td>
                <Flex direction="column" alignItems="flex-start" maxWidth="280px">
                  <Typography textColor="neutral800" ellipsis>{row.targetLabel ?? row.targetId ?? '—'}</Typography>
                  <Typography variant="pi" textColor="neutral500" ellipsis>
                    {[row.targetUid, row.localeCode].filter(Boolean).join(' · ')}
                  </Typography>
                </Flex>
              </Td>
              <Td>
                {row.outcome === 'success' ? (
                  <Badge backgroundColor="success100" textColor="success700">
                    <Flex gap={1} alignItems="center"><CheckCircle width="1.2rem" height="1.2rem" />Succeeded</Flex>
                  </Badge>
                ) : (
                  <Badge backgroundColor="danger100" textColor="danger700">
                    <Flex gap={1} alignItems="center"><CrossCircle width="1.2rem" height="1.2rem" />Failed</Flex>
                  </Badge>
                )}
              </Td>
              <Td>
                <Typography variant="pi" textColor="neutral600">{row.ipAddress ?? '—'}</Typography>
              </Td>
              <Td onClick={(event: React.MouseEvent) => event.stopPropagation()}>
                <IconButton label="View details" variant="ghost" onClick={() => onOpen(row.id)}>
                  <Eye />
                </IconButton>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
        <Flex gap={2} alignItems="center">
          <SingleSelect
            aria-label="Entries per page"
            size="S"
            value={String(pagination.pageSize)}
            onChange={(value: string | number) => onPageSize(Number(value))}
          >
            {PAGE_SIZES.map((size) => (
              <SingleSelectOption key={size} value={String(size)}>
                {String(size)}
              </SingleSelectOption>
            ))}
          </SingleSelect>
          <Typography variant="pi" textColor="neutral600">
            {`Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(pagination.total)}`}
          </Typography>
        </Flex>

        <Flex gap={2} alignItems="center">
          <Button variant="tertiary" size="S" disabled={pagination.page <= 1 || loading} onClick={() => onPage(pagination.page - 1)}>
            Previous
          </Button>
          <Typography variant="pi" textColor="neutral600">
            {`Page ${formatNumber(pagination.page)} of ${formatNumber(pagination.pageCount)}`}
          </Typography>
          <Button
            variant="tertiary"
            size="S"
            disabled={pagination.page >= pagination.pageCount || loading}
            onClick={() => onPage(pagination.page + 1)}
          >
            Next
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
};
