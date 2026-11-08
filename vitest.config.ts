import { defineConfig } from 'vitest/config';

// One project per package. Database tests (core, federation) run files serially against
// the lane's test database, which tests/db-setup.ts recreates from the migrations once per run.
const db = {
  globalSetup: ['../../tests/db-global-setup.ts'],
  setupFiles: ['../../tests/db-setup.ts'],
  fileParallelism: false,
};

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'schema', root: 'packages/schema', include: ['src/**/*.test.ts'] } },
      { test: { name: 'core', root: 'packages/core', include: ['src/**/*.test.ts'], ...db } },
      { test: { name: 'federation', root: 'packages/federation', include: ['src/**/*.test.ts'], ...db } },
      { test: { name: 'ui', root: 'packages/ui', include: ['src/**/*.test.{ts,tsx}'] } },
      { test: { name: 'web', root: 'packages/web', include: ['src/**/*.test.{ts,tsx}'] } },
      { test: { name: 'tools', root: '.', include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'] } },
    ],
  },
});
