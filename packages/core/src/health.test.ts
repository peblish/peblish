import { afterEach, expect, test, vi } from 'vitest';
import { closePools } from './db/pools.ts';
import { databaseReady } from './health.ts';

// The test setup points DATABASE_URL at the lane's test database.
const url = process.env.DATABASE_URL;
afterEach(async () => {
  process.env.DATABASE_URL = url;
  await closePools();
  vi.restoreAllMocks();
});

test('the test database is ready', async () => {
  expect(await databaseReady()).toBe(true);
});

test('a missing DATABASE_URL is not ready and is logged once', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await closePools();
  delete process.env.DATABASE_URL;
  expect(await databaseReady()).toBe(false);
  expect(await databaseReady()).toBe(false);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0]?.[0]).toBe('readiness: the database is not configured:');
});
