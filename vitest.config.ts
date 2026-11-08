import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// One project per package, plus the repository's own tests and the tools/* packages.
// Database tests (core, federation, tools) run files serially against the lane's test
// database, which tests/db-global-setup.ts recreates from the migrations once per run.
const db = {
  globalSetup: [join(import.meta.dirname, 'tests/db-global-setup.ts')],
  setupFiles: [join(import.meta.dirname, 'tests/db-setup.ts')],
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
      { test: { name: 'repo', root: '.', include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'] } },
      { test: { name: 'tools', root: 'tools', include: ['*/src/**/*.test.ts'], ...db } },
    ],
  },
});
