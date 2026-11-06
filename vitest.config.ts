import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    // Integration tests boot a real Strapi app and own a database file. They have their own
    // config (`vitest.integration.config.ts`) so `npm test` stays a fast, dependency-free run.
    exclude: ['server/tests/integration/**'],
    environment: 'node',
    // Streaming cases build large CSV files on disk to prove memory stays bounded; the default
    // 5s is not enough for the 200k-row ceiling checks.
    testTimeout: 60_000,
  },
});
