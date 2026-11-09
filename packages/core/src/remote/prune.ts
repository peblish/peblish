import { sql } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import { activities, inboxDedupe, inboxRaw } from '../db/tables/federation.ts';
import { deliveries } from '../delivery/tables.ts';
import { throttles } from '../identity/tables.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane REM. Retention for the tables that otherwise grow for ever: the inbox (every
// activity as received, bodies up to 512 KiB), the delivery queue (every send), the dedupe
// markers of applied activities and the expired windows of the rate limiter.

/** How long a row is kept, and how a prune run is cut into transactions. */
export const retention = {
  /** An inbox row that is applied, skipped or failed. A pending row is never deleted. */
  inboxRawMs: 14 * 24 * 60 * 60 * 1000,
  /**
   * A delivery that is delivered, failed or skipped. The health job reads the last week only. A
   * boost's deliveries stay until it is withdrawn (`openBoost`): the withdrawal goes to them.
   */
  deliveriesMs: 30 * 24 * 60 * 60 * 1000,
  /** A marker that an activity was applied. Peers retry for days and the inbox refuses a stale request date, so a marker this old guards nothing. */
  inboxDedupeMs: 90 * 24 * 60 * 60 * 1000,
  /** A rate limiter window that ended. The longest window a scope uses is an hour (identity/throttle.ts); an ended one counts as no row. */
  throttlesMs: 24 * 60 * 60 * 1000,
  /** Rows deleted per transaction, and transactions per run (a larger backlog finishes on the next run). */
  batch: 2000,
  maxBatches: 25,
} as const;

export type PrunedTable = 'inbox_raw' | 'deliveries' | 'inbox_dedupe' | 'throttles';

const keepMs = (table: PrunedTable): number =>
  ({
    inbox_raw: retention.inboxRawMs,
    deliveries: retention.deliveriesMs,
    inbox_dedupe: retention.inboxDedupeMs,
    throttles: retention.throttlesMs,
  })[table];

/**
 * Whether a delivery row (of the `deliveries` in scope) sent a boost that is not taken back yet:
 * a local community's Announce of a post (Announce(Page), the Mastodon-like shape) with no local
 * Undo of it. The withdrawal (federation delivery/withdraw.ts) sends the Undo and the author's
 * Delete to the inboxes in these rows, so they stay until the boost is undone or the post is gone.
 */
const openBoost = sql`(
  ${deliveries}.activity_type = 'Announce' and exists (
    select 1 from ${activities} a join ${posts} p on p.ap_id = a.object_ap_id
    where a.ap_id = ${deliveries}.activity_ap_id and a.local and a.type = 'Announce'
      and not exists (select 1 from ${activities} u where u.local and u.type = 'Undo' and u.object_ap_id = a.ap_id)))`;

/**
 * Deletes up to one batch of rows older than the grant's table keeps; returns how many went. The
 * candidates are claimed with FOR UPDATE SKIP LOCKED, so a row another transaction is changing
 * (the inbox job putting a skipped row back to pending) is left, and the DELETE states the
 * conditions again, so a row that stopped qualifying between the two steps is kept. An applied
 * activity's `activities` row stays and loses its link to the deleted bytes (ON DELETE SET NULL),
 * so the relay falls back to the parsed copy.
 */
export const pruneBatch = defineMutation({
  action: 'remote.prune',
  emits: ['remote.pruned'],
  async run(t, grant, input: { now: Date }) {
    const { table } = grant.subject;
    const cutoff = new Date(input.now.getTime() - keepMs(table)).toISOString();
    const limit = retention.batch;
    const gone = await (() => {
      switch (table) {
        case 'inbox_raw':
          return t.db.execute<{ id: string }>(sql`
            delete from ${inboxRaw}
            where id in (
              select id from ${inboxRaw} where state <> 'pending' and processed_at < ${cutoff}::timestamptz
              limit ${limit} for update skip locked)
              and state <> 'pending' and processed_at < ${cutoff}::timestamptz
            returning id`);
        case 'deliveries':
          return t.db.execute<{ id: string }>(sql`
            delete from ${deliveries}
            where id in (
              select id from ${deliveries} where state <> 'pending' and settled_at < ${cutoff}::timestamptz and not ${openBoost}
              limit ${limit} for update skip locked)
              and state <> 'pending' and settled_at < ${cutoff}::timestamptz and not ${openBoost}
            returning id`);
        case 'inbox_dedupe':
          return t.db.execute<{ id: string }>(sql`
            delete from ${inboxDedupe}
            where activity_id in (
              select activity_id from ${inboxDedupe} where seen_at < ${cutoff}::timestamptz
              limit ${limit} for update skip locked)
              and seen_at < ${cutoff}::timestamptz
            returning activity_id as id`);
        case 'throttles':
          return t.db.execute<{ id: string }>(sql`
            delete from ${throttles}
            where (scope, key) in (
              select scope, key from ${throttles} where window_start < ${cutoff}::timestamptz
              limit ${limit} for update skip locked)
              and window_start < ${cutoff}::timestamptz
            returning key as id`);
      }
    })();
    if (gone.length > 0) await t.emit({ type: 'remote.pruned', v: 1, table, rows: gone.length });
    return { rows: gone.length };
  },
});
