import { Box, Flex, Tooltip, Typography } from '@strapi/design-system';
import styled from 'styled-components';
import type { Stats } from '../utils/api';
import { formatNumber } from '../utils/format';

const PLOT_HEIGHT = 160;

/**
 * Events per day, one series.
 *
 * - A single series needs no legend; the card title names it.
 * - Colour comes from the admin theme (`primary600`), so it follows light and dark mode.
 * - Each day is a full-height column: the hover target is the whole column, not the bar, so
 *   short bars are as easy to point at as tall ones.
 * - Only the first, middle and last day are labelled on the axis; the tooltip carries the rest.
 */

const Plot = styled.div`
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: ${PLOT_HEIGHT}px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.neutral200};
`;

const GridLine = styled.div<{ $at: number }>`
  position: absolute;
  left: 0;
  right: 0;
  bottom: ${({ $at }) => $at}%;
  border-top: 1px dashed ${({ theme }) => theme.colors.neutral150};
  pointer-events: none;
`;

const Column = styled.div`
  flex: 1 1 0;
  min-width: 3px;
  display: flex;
  align-items: flex-end;
  border-radius: 4px 4px 0 0;
  cursor: default;
  outline: none;

  &:hover,
  &:focus-visible {
    background: ${({ theme }) => theme.colors.neutral100};
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px ${({ theme }) => theme.colors.primary600};
  }
`;

const Bar = styled.div<{ $height: number; $empty: boolean }>`
  width: 100%;
  height: ${({ $height }) => $height}%;
  min-height: ${({ $empty }) => ($empty ? '0' : '2px')};
  background: ${({ theme }) => theme.colors.primary600};
  border-radius: 4px 4px 0 0;
  transition: height 200ms ease-out;
`;

function niceMax(value: number): number {
  if (value <= 4) return Math.max(value, 1);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function dayLabel(date: string, long = false): string {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return value.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

export const ActivityChart = ({ perDay }: { perDay: Stats['perDay'] }) => {
  const peak = Math.max(0, ...perDay.map((day) => day.count));
  const max = niceMax(peak);
  const labelled = new Set([0, Math.floor((perDay.length - 1) / 2), perDay.length - 1]);

  if (perDay.length === 0) {
    return (
      <Box padding={6}>
        <Typography textColor="neutral600">No activity in this period.</Typography>
      </Box>
    );
  }

  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Flex justifyContent="space-between">
        <Typography variant="pi" textColor="neutral600">
          {`Peak ${formatNumber(peak)} per day`}
        </Typography>
        <Typography variant="pi" textColor="neutral500">
          {`Scale 0–${formatNumber(max)}`}
        </Typography>
      </Flex>

      <Plot role="list" aria-label="Events per day">
        <GridLine $at={50} />
        <GridLine $at={100} />
        {perDay.map((day) => {
          const label = `${dayLabel(day.date, true)}: ${formatNumber(day.count)} event${day.count === 1 ? '' : 's'}${
            day.failures > 0 ? `, ${formatNumber(day.failures)} failed` : ''
          }`;

          return (
            <Tooltip key={day.date} label={label} delayDuration={0}>
              <Column role="listitem" aria-label={label} tabIndex={0}>
                <Bar $height={(day.count / max) * 100} $empty={day.count === 0} />
              </Column>
            </Tooltip>
          );
        })}
      </Plot>

      <Flex justifyContent="space-between">
        {perDay.map((day, index) =>
          labelled.has(index) ? (
            <Typography key={day.date} variant="pi" textColor="neutral600">
              {dayLabel(day.date)}
            </Typography>
          ) : null
        )}
      </Flex>
    </Flex>
  );
};
