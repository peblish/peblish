import { afterAll, beforeAll, inject } from 'vitest';

// Per test file: point the pools at the test database and start from empty tables.
process.env.DATABASE_URL = inject('databaseUrl');

const { truncateAll } = await import('../packages/core/src/testing/db.ts');
const { closePools } = await import('../packages/core/src/db/pools.ts');

beforeAll(truncateAll);
afterAll(closePools);
