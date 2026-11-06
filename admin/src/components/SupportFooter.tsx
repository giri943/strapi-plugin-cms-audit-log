import { Box, Flex, Link, Typography } from '@strapi/design-system';

const SPONSOR_URL = 'https://github.com/sponsors/giri943';
const REPOSITORY_URL = 'https://github.com/giri943/strapi-plugin-cms-audit-log';

/**
 * One quiet line at the foot of the settings page. Settings is visited rarely and only by
 * people who manage the plugin, so it never gets in the way of the dashboard.
 */
export const SupportFooter = () => (
  <Box paddingTop={8} paddingBottom={4}>
    <Flex justifyContent="center" gap={2} wrap="wrap">
      <Typography variant="pi" textColor="neutral500">
        Audit Log is free and open source.
      </Typography>
      <Link href={SPONSOR_URL} isExternal>
        ♥ Sponsor this plugin
      </Link>
      <Typography variant="pi" textColor="neutral500" aria-hidden>
        ·
      </Typography>
      <Link href={`${REPOSITORY_URL}/issues`} isExternal>
        Report an issue
      </Link>
    </Flex>
  </Box>
);
