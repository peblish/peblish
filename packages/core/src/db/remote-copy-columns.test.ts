import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { db } from './read.ts';
import { votes } from './tables/content.ts';
import { activities } from './tables/federation.ts';
import { writer } from './write.ts';

// Migration 0015 takes votes.raw and activities.inbox_raw_id off the definitions without
// changing the database: inserts from this release name neither, so the later migration that
// drops them cannot break a process still running this one. That later release flips the
// second test.

const uuid = '00000000-0000-7000-8000-000000000000';

test('vote and activity inserts name neither votes.raw nor activities.inbox_raw_id', () => {
  const vote = writer()
    .insert(votes)
    .values({ apId: 'https://feddit.test/activities/like/1', local: true, instanceId: uuid, voterId: uuid, postId: uuid, value: 1 })
    .toSQL().sql;
  expect(vote).toMatch(/^insert into "votes" \(/);
  expect(vote).not.toContain('"raw"');

  const activity = writer()
    .insert(activities)
    .values({
      apId: 'https://feddit.test/activities/announce/1',
      type: 'Announce',
      actorApId: 'https://feddit.test/c/news',
      local: true,
      raw: {},
    })
    .toSQL().sql;
  expect(activity).toMatch(/^insert into "activities" \(/);
  expect(activity).toContain('"raw"');
  expect(activity).not.toContain('inbox_raw_id');
});

test('the migrated database still has both columns, the FK and the index', async () => {
  const columns = await db().execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where (table_name, column_name) in (('votes', 'raw'), ('activities', 'inbox_raw_id')) order by table_name`);
  expect([...columns]).toEqual([
    { table_name: 'activities', column_name: 'inbox_raw_id' },
    { table_name: 'votes', column_name: 'raw' },
  ]);
  const fk = await db().execute<{ conname: string }>(
    sql`select conname from pg_constraint where conname = 'activities_inbox_raw_id_inbox_raw_id_fk' and confdeltype = 'n'`,
  );
  expect(fk).toHaveLength(1);
  const index = await db().execute<{ indexname: string }>(sql`select indexname from pg_indexes where indexname = 'activities_inbox_raw'`);
  expect(index).toHaveLength(1);
});
