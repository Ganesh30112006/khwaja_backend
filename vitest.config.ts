import { defineConfig } from 'vitest/config';

export const TEST_DB_PORT = 54330;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // One real PostgreSQL database is shared, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://postgres:test-pw@localhost:${TEST_DB_PORT}/voterdesk_test`,
      DATABASE_SSL: 'false',
      APP_TIME_ZONE: 'Asia/Kolkata',
      LOGIN_RATE_LIMIT: '1000',
    },
  },
});
