import type { Uuid } from '@peblish/schema/ids';
import { sql } from 'drizzle-orm';
import { comments, posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { objectRechecks } from './tables.ts';

// Owned by lane REM. Which held remote posts and comments are due to be asked after at their own
// servers. Nothing else would ask: the missing-object job fetches objects we lack, and a peer's
// own Delete reaches us only when the peer sends it, so an object whose server dropped it
// quietly (a 410 or a Tombstone when asked) would stay for ever.

/** How often one object is rechecked, and how many a run takes. */
export const rechecks = {
  /** An object is asked after again once this long has passed since it was stored or last asked after. */
  everyMs: 24 * 60 * 60 * 1000,
  /** Objects a run takes, oldest first; the rest wait for the next run. */
  perRun: 100,
} as const;

export type DueObject = { kind: 'post' | 'comment'; id: Uuid; apId: string };

/**
 * Takes up to `input.limit` of the held remote posts and comments that were stored or last
 * asked after more than `rechecks.everyMs` ago, oldest first, and marks them asked after now
 * in the same statement. The mark is the claim: two workers running at once take different
 * objects (the second finds the first's marks fresh), and an object whose server is down is
 * not asked again until tomorrow rather than at the head of every run. Deleted objects are
 * left alone, and so are this server's own.
 */
export const claimRechecks = defineMutation({
  action: 'remote.object_recheck',
  emits: ['remote.rechecked'],
  async run(t, _grant, input: { now: Date; limit: number }) {
    const now = input.now.toISOString();
    const dueBefore = new Date(input.now.getTime() - rechecks.everyMs).toISOString();
    const taken = await t.db.execute<DueObject>(sql`
      with due as (
        select * from (
          select 'post' as kind, p.id, p.ap_id as "apId", coalesce(c.checked_at, p.created_at) as last_checked
          from ${posts} p left join ${objectRechecks} c on c.object_id = p.id
          where not p.local and p.deleted_at is null and coalesce(c.checked_at, p.created_at) < ${dueBefore}::timestamptz
          union all
          select 'comment', m.id, m.ap_id, coalesce(c.checked_at, m.created_at)
          from ${comments} m left join ${objectRechecks} c on c.object_id = m.id
          where not m.local and m.deleted_at is null and coalesce(c.checked_at, m.created_at) < ${dueBefore}::timestamptz
        ) candidates
        order by last_checked, id
        limit ${input.limit}
      ), marked as (
        insert into ${objectRechecks} (object_id, checked_at)
        select id, ${now}::timestamptz from due
        on conflict (object_id) do update set checked_at = excluded.checked_at
          where ${objectRechecks.checkedAt} < ${dueBefore}::timestamptz
        returning object_id
      )
      select due.kind, due.id, due."apId" from due join marked on marked.object_id = due.id
      order by due.last_checked, due.id`);
    const objects = [...taken];
    if (objects.length > 0) await t.emit({ type: 'remote.rechecked', v: 1, objects: objects.length });
    return objects;
  },
});
