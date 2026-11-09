import type { Uuid } from '@peblish/schema/ids';
import { inArray, lt, sql } from 'drizzle-orm';
import { comments, posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { objectRechecks } from './tables.ts';

// Owned by lane REM. Which held remote posts and comments are due to be asked after at their own
// servers. Nothing else would ask: the missing-object job fetches objects we lack, and a peer's
// own Delete reaches us only when the peer sends it, so an object whose server dropped it
// quietly (a 410 or a Tombstone when asked) would stay for ever.
//
// A run reads a bounded number of rows, however many objects are held: the marks gone stale
// (an index walk in `checked_at` order) and the objects stored since the newest mark (an index
// walk in id order, which is the order they were stored in, ids being uuidv7). Marks are
// written in that order, so the newest mark's id is where the objects never asked after begin.

/** How often one object is rechecked, and how many a run takes. */
export const rechecks = {
  /** An object is asked after again once this long has passed since it was stored or last asked after. */
  everyMs: 24 * 60 * 60 * 1000,
  /** Objects a run takes, oldest first; the rest wait for the next run. */
  perRun: 100,
} as const;

export type DueObject = { kind: 'post' | 'comment'; id: Uuid; apId: string };

type Candidate = DueObject & { lastChecked: number; fresh: boolean };
type Marked = Omit<Candidate, 'fresh'> & { live: boolean };

const noId = '00000000-0000-0000-0000-000000000000';

/**
 * Takes up to `input.limit` of the held remote posts and comments that were stored or last
 * asked after more than `rechecks.everyMs` ago, oldest first, and marks them asked after now
 * in the same transaction. The mark is the claim: two workers running at once take different
 * objects (the second finds the first's marks fresh), and an object whose server is down is
 * not asked again until tomorrow rather than at the head of every run. Deleted objects are
 * left alone, and so are this server's own; a mark whose object is deleted or gone is dropped.
 *
 * An object stored before the newest mark's id and never marked (one deleted when its turn
 * came, and restored since) is not asked after until it has a mark again.
 */
export const claimRechecks = defineMutation({
  action: 'remote.object_recheck',
  emits: ['remote.rechecked'],
  async run(t, _grant, input: { now: Date; limit: number }) {
    const { limit } = input;
    if (limit < 1) return [];
    const dueBefore = new Date(input.now.getTime() - rechecks.everyMs);
    const before = dueBefore.toISOString();

    // Objects asked after before: the stalest marks, `limit` of them at most.
    const stale = await t.db.execute<Marked>(sql`
      select case when p.id is not null then 'post' else 'comment' end as kind, h.object_id as id,
        coalesce(p.ap_id, m.ap_id) as "apId", (extract(epoch from h.checked_at) * 1000)::float8 as "lastChecked",
        coalesce(not p.local and p.deleted_at is null, not m.local and m.deleted_at is null, false) as live
      from (select object_id, checked_at from ${objectRechecks} where checked_at < ${before}::timestamptz
            order by checked_at, object_id limit ${limit}) h
      left join ${posts} p on p.id = h.object_id
      left join ${comments} m on m.id = h.object_id`);
    const dead = stale.filter((row) => !row.live).map((row) => row.id);
    if (dead.length > 0) await t.db.delete(objectRechecks).where(inArray(objectRechecks.objectId, dead));

    // Objects never asked after, in the order they were stored, past the newest mark (a mark is written
    // only for an object past the one before it, so none lies beyond it): `limit` of each kind at most.
    const [newest] = await t.db.execute<{ id: Uuid }>(sql`select object_id as id from ${objectRechecks} order by object_id desc limit 1`);
    const after = newest?.id ?? noId;
    const fresh = await t.db.execute<DueObject & { lastChecked: number }>(sql`
      (select 'post' as kind, p.id, p.ap_id as "apId", (extract(epoch from p.created_at) * 1000)::float8 as "lastChecked"
       from ${posts} p
       where p.id > ${after}::uuid and not p.local and p.deleted_at is null and p.created_at < ${before}::timestamptz
       order by p.id limit ${limit})
      union all
      (select 'comment', m.id, m.ap_id, (extract(epoch from m.created_at) * 1000)::float8
       from ${comments} m
       where m.id > ${after}::uuid and not m.local and m.deleted_at is null and m.created_at < ${before}::timestamptz
       order by m.id limit ${limit})`);
    const storedOrder = [...fresh].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);

    const byAge = (a: Candidate, b: Candidate) => a.lastChecked - b.lastChecked || (a.id < b.id ? -1 : 1);
    const candidates = [
      ...stale.filter((row) => row.live).map((row): Candidate => ({ ...row, fresh: false })),
      ...storedOrder.map((row): Candidate => ({ ...row, fresh: true })),
    ].sort(byAge);
    const chosen = candidates.slice(0, limit);
    // Marks follow the stored order: a never-asked object is taken only if every one stored before it is too.
    const skipped = storedOrder.find((row) => !chosen.some((c) => c.id === row.id));
    const take = chosen.filter((c) => !c.fresh || !skipped || c.id < skipped.id);
    if (take.length === 0) return [];

    const marked = await t.db
      .insert(objectRechecks)
      .values(take.map((c) => ({ objectId: c.id, checkedAt: input.now })))
      .onConflictDoUpdate({
        target: objectRechecks.objectId,
        set: { checkedAt: input.now },
        setWhere: lt(objectRechecks.checkedAt, dueBefore),
      })
      .returning({ id: objectRechecks.objectId });
    const mine = new Set(marked.map((row) => row.id));
    const objects = take.filter((c) => mine.has(c.id)).map(({ kind, id, apId }): DueObject => ({ kind, id, apId }));
    if (objects.length > 0) await t.emit({ type: 'remote.rechecked', v: 1, objects: objects.length });
    return objects;
  },
});
