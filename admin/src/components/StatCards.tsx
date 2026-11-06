import { Box, Flex, Grid, Typography } from '@strapi/design-system';
import { ClockCounterClockwise, Pencil, User, WarningCircle } from '@strapi/icons';
import type { Stats } from '../utils/api';
import { formatNumber } from '../utils/format';

interface CardProps {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'danger';
}

/**
 * A headline number per tile. Status colour is used only for failed sign-ins, and only when
 * there are some, and it always comes with an icon and words, never colour alone.
 */
const StatCard = ({ label, value, hint, icon, tone = 'neutral' }: CardProps) => {
  const alarming = tone === 'danger' && value > 0;

  return (
    <Box
      background="neutral0"
      hasRadius
      shadow="tableShadow"
      padding={5}
      borderColor={alarming ? 'danger200' : 'neutral150'}
      height="100%"
    >
      <Flex direction="column" alignItems="flex-start" gap={2}>
        <Flex gap={2} alignItems="center">
          <Box color={alarming ? 'danger600' : 'neutral500'}>{icon}</Box>
          <Typography variant="sigma" textColor="neutral600">
            {label}
          </Typography>
        </Flex>
        <Typography variant="alpha" tag="p" textColor={alarming ? 'danger700' : 'neutral800'}>
          {formatNumber(value)}
        </Typography>
        <Typography variant="pi" textColor="neutral600">
          {hint}
        </Typography>
      </Flex>
    </Box>
  );
};

export const StatCards = ({ stats }: { stats: Stats }) => (
  <Grid.Root gap={4}>
    <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
      <StatCard
        label="Events"
        value={stats.total}
        hint={stats.failures > 0 ? `${formatNumber(stats.failures)} failed` : 'All succeeded'}
        icon={<ClockCounterClockwise />}
      />
    </Grid.Item>
    <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
      <StatCard
        label="Content changes"
        value={stats.byCategory.content ?? 0}
        hint={`${formatNumber(stats.byCategory.media ?? 0)} media changes`}
        icon={<Pencil />}
      />
    </Grid.Item>
    <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
      <StatCard
        label="Active users"
        value={stats.activeActors}
        hint="Admins, tokens and users who made changes"
        icon={<User />}
      />
    </Grid.Item>
    <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
      <StatCard
        label="Failed sign-ins"
        value={stats.failedLogins}
        hint={stats.failedLogins > 0 ? 'Filter by Sign-in to review them' : 'None in this period'}
        icon={<WarningCircle />}
        tone="danger"
      />
    </Grid.Item>
  </Grid.Root>
);
