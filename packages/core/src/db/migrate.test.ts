import { afterAll, expect, test } from 'vitest';
import postgres from 'postgres';
import { dropDatabase, recreateDatabase } from '../testing/recreate.ts';
import { runMigrations } from './migrate.ts';

// Two migrate processes started together (replicas in one rollout) on a fresh database.
const url = new URL(process.env.DATABASE_URL ?? '');
url.pathname = url.pathname.replace(/_test$/, '_migrate_test');
afterAll(() => dropDatabase(url));

test('concurrent migrate runs take turns, bootstrap included, and apply each migration once', async () => {
  await recreateDatabase(url, { migrate: false });
  const steps: string[] = [];
  const run = (name: string) =>
    runMigrations(url.href, {
      async after() {
        steps.push(`${name} bootstrap starts`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        steps.push(`${name} bootstrap ends`);
      },
    });
  await Promise.all([run('a'), run('b')]);
  const [first, second] = steps[0]?.startsWith('a') ? ['a', 'b'] : ['b', 'a'];
  expect(steps).toEqual([`${first} bootstrap starts`, `${first} bootstrap ends`, `${second} bootstrap starts`, `${second} bootstrap ends`]);

  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    const journal = await client`select hash from drizzle.__drizzle_migrations`;
    expect(new Set(journal.map(({ hash }) => hash)).size).toBe(journal.length);
    expect(journal.length).toBeGreaterThanOrEqual(2);
  } finally {
    await client.end();
  }
});
