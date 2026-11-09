import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import postgres from 'postgres';
import { dropDatabase, recreateDatabase } from '../testing/recreate.ts';
import { MigrationHistoryError, migrationsFolder, runMigrations } from './migrate.ts';

// Two migrate processes started together (replicas in one rollout) on a fresh database.
const url = new URL(process.env.DATABASE_URL ?? '');
url.pathname = url.pathname.replace(/_test$/, '_migrate_test');
afterAll(() => dropDatabase(url));

// Each case migrates whole databases (eleven migrations since the wave 3 fixes): over 5 s on a busy shared Postgres.
const migrating = { timeout: 30_000 };

test('concurrent migrate runs take turns, bootstrap included, and apply each migration once', migrating, async () => {
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

test("a database migrated from different migration files is refused before anything runs; a newer build's are not", migrating, async () => {
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

test(
  '0010 refuses to run while a preservation hold is in force, since it would leave the hold without an authority',
  migrating,
  async () => {
    // The migrations up to 0009 in a folder of their own: the database as it was before 0010.
    const before = await mkdtemp(join(tmpdir(), 'peblish-0009-'));
    try {
      const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(
        0,
        journal.entries.findIndex(({ tag }) => tag === '0010_wave_3_fixes'),
      );
      await mkdir(join(before, 'meta'));
      await writeFile(join(before, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries) await copyFile(join(migrationsFolder, `${tag}.sql`), join(before, `${tag}.sql`));
      await recreateDatabase(url, { migrate: false });
      await runMigrations(url.href, { folder: before });
    } finally {
      await rm(before, { recursive: true, force: true });
    }

    const client = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const [image] = await client<{ id: string }[]>`insert into media (id, kind) values (gen_random_uuid(), 'upload') returning id`;
      const [incident] = await client<{ id: string }[]>`
      insert into media_evidence (id, media_id, source, classification, manifest, manifest_sha256, hold_reference, hold_until)
      values (gen_random_uuid(), ${image!.id}, 'list', 'csam', '{}', 'x', 'AFP-1', now() + interval '30 days') returning id`;
      const column = () =>
        client`select 1 from information_schema.columns where table_name = 'media_evidence' and column_name = 'hold_authority'`;

      await expect(runMigrations(url.href)).rejects.toMatchObject({
        cause: {
          message: expect.stringMatching(
            /^1 media_evidence row has a preservation hold in force\. .*classify each active hold's authority/,
          ),
        },
      });
      expect(await column()).toHaveLength(0);

      // A hold whose date has passed protects nothing, so 0010 runs.
      await client`update media_evidence set hold_until = now() - interval '1 day' where id = ${incident!.id}`;
      await expect(runMigrations(url.href)).resolves.toBeUndefined();
      expect(await column()).toHaveLength(1);
    } finally {
      await client.end();
    }
  },
);
