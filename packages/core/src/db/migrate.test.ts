import { afterAll, expect, test } from 'vitest';
import postgres from 'postgres';
import { dropDatabase, recreateDatabase } from '../testing/recreate.ts';
import { MigrationHistoryError, runMigrations } from './migrate.ts';

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

test("a database migrated from different migration files is refused before anything runs; a newer build's are not", async () => {
  await recreateDatabase(url);
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    const [latest] = await client<{ newest: string }[]>`select max(created_at)::text as newest from drizzle.__drizzle_migrations`;
    // A newer build applied a migration this one does not know: a rollback meets that.
    await client`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-build', ${Number(latest?.newest) + 1})`;
    await expect(runMigrations(url.href)).resolves.toBeUndefined();
    // An applied migration this build does not know, older than its newest: other files.
    await client`update drizzle.__drizzle_migrations set hash = 'regenerated-since' where created_at = (select min(created_at) from drizzle.__drizzle_migrations)`;
    await expect(runMigrations(url.href)).rejects.toThrow(MigrationHistoryError);
    await expect(runMigrations(url.href)).rejects.toThrow(/migrated from different migration files: 1 applied migration/);
  } finally {
    await client.end();
  }
});
