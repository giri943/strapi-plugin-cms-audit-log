import { Box, Flex, Typography } from '@strapi/design-system';
import styled from 'styled-components';
import { formatNumber } from '../utils/format';

const Track = styled.div`
  height: 6px;
  border-radius: 3px;
  background: ${({ theme }) => theme.colors.neutral150};
  overflow: hidden;
`;

const Fill = styled.div<{ $width: number }>`
  height: 100%;
  width: ${({ $width }) => $width}%;
  border-radius: 3px;
  background: ${({ theme }) => theme.colors.primary600};
`;

export interface TopItem {
  key: string;
  label: string;
  count: number;
  onSelect?: () => void;
}

const Row = styled.button`
  all: unset;
  display: block;
  width: 100%;
  cursor: pointer;
  border-radius: 4px;
  padding: 4px;
  margin: -4px;

  &:hover {
    background: ${({ theme }) => theme.colors.neutral100};
  }
  &:focus-visible {
    box-shadow: 0 0 0 2px ${({ theme }) => theme.colors.primary600};
  }
`;

/** A ranked list with a length bar, each row clickable to filter the table by it. */
export const TopList = ({ title, items, empty }: { title: string; items: TopItem[]; empty: string }) => {
  const max = Math.max(1, ...items.map((item) => item.count));

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Typography variant="sigma" textColor="neutral600">
        {title}
      </Typography>
      {items.length === 0 ? (
        <Typography variant="pi" textColor="neutral500">
          {empty}
        </Typography>
      ) : (
        items.map((item) => (
          <Row key={item.key} type="button" onClick={item.onSelect} aria-label={`Filter by ${item.label}`}>
            <Flex justifyContent="space-between" gap={2} paddingBottom={1}>
              <Typography variant="omega" ellipsis textColor="neutral800">
                {item.label}
              </Typography>
              <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                {formatNumber(item.count)}
              </Typography>
            </Flex>
            <Track>
              <Fill $width={(item.count / max) * 100} />
            </Track>
          </Row>
        ))
      )}
      <Box />
    </Flex>
  );
};
