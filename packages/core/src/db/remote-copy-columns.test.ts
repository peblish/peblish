import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { db } from './read.ts';
import { votes } from './tables/content.ts';
import { activities } from './tables/federation.ts';
import { writer } from './write.ts';

// Migration 0015 took votes.raw and activities.inbox_raw_id off the definitions, so inserts
// stopped naming them; 0016 then dropped them from the database, with the FK and the index.

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

test('the migrated database has neither column, nor the FK or the index', async () => {
  const columns = await db().execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where (table_name, column_name) in (('votes', 'raw'), ('activities', 'inbox_raw_id'))`);
  expect([...columns]).toEqual([]);
  const fk = await db().execute<{ conname: string }>(
    sql`select conname from pg_constraint where conname = 'activities_inbox_raw_id_inbox_raw_id_fk'`,
  );
  expect(fk).toHaveLength(0);
  const index = await db().execute<{ indexname: string }>(sql`select indexname from pg_indexes where indexname = 'activities_inbox_raw'`);
  expect(index).toHaveLength(0);
});
