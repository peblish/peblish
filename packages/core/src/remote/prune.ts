import { sql } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import { activities, inboxDedupe, inboxRaw } from '../db/tables/federation.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { deliveries } from '../delivery/tables.ts';
import { throttles } from '../identity/tables.ts';
import { outboxSkipped } from '../outbox/tables.ts';
import { cursorCreationLock } from '../outbox/worker.ts';
import { defineMutation } from '../tx/mutation.ts';
import type { OpenTx } from '../tx/tx.ts';

// Owned by lane REM. Retention for the tables that otherwise grow for ever: the inbox (every
// activity as received, bodies up to 512 KiB; a row rejected or skipped for good keeps only the
// first KiB once it settles, federation inbound/queue.ts), the delivery queue (every send), the
// dedupe markers of applied activities, the expired windows of the rate limiter and the outbox
// events every consumer has handled.

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
  /**
   * An outbox event every cursor in outbox_cursors has passed, unless a consumer skipped it
   * (outbox_skipped: its payload is what an operator replays). A consumer that starts at
   * 'beginning' sees only the events this window leaves.
   */
  outboxMs: 14 * 24 * 60 * 60 * 1000,
  /** Rows deleted per transaction, and transactions per run (a larger backlog finishes on the next run). */
  batch: 2000,
  maxBatches: 25,
} as const;

export type PrunedTable = 'inbox_raw' | 'deliveries' | 'inbox_dedupe' | 'throttles' | 'outbox';

const keepMs = (table: PrunedTable): number =>
  ({
    inbox_raw: retention.inboxRawMs,
    deliveries: retention.deliveriesMs,
    inbox_dedupe: retention.inboxDedupeMs,
    throttles: retention.throttlesMs,
    outbox: retention.outboxMs,
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

const nameList = (names: readonly string[]) =>
  sql`array[${sql.join(
    names.map((name) => sql`${name}`),
    sql`, `,
  )}]::text[]`;

/**
 * A cursor at or past this transaction's own id: no transaction of this cluster can have set it.
 * Every cursor the worker writes is an earlier transaction's id, or the horizon it saw (at most the
 * id of the transaction that wrote it), and pg_current_xact_id() is newer than every id the
 * cluster gave out before. pg_snapshot_xmin would not do: a cursor a consumer created at 'now'
 * equals the horizon until another transaction starts. Such a cursor comes from a restore onto
 * another cluster (the saved cursors keep the old cluster's ids), where new events get ids below
 * every cursor: the worker never reads them, and the boundary would count them as handled.
 */
const aheadOfCluster = sql`${outboxCursors.txId} >= pg_current_xact_id()`;

/**
 * The oldest cursor in outbox_cursors, as a (tx_id, event_id) row, or no row while a cursor is
 * ahead of this cluster. Every cursor counts, registered here or not: a worker of an older version
 * running beside a newer one during a deploy does not know the newer one's consumers, and a newer
 * consumer that starts at 'beginning' has read nothing yet. The rows at or before it are final: a
 * cursor only reaches rows whose tx_id is below the oldest running transaction (pg_snapshot_xmin,
 * outbox/worker.ts), every transaction below that has ended, and any later one gets a larger id,
 * so no event can still commit at or before a cursor.
 */
const slowestCursor = sql`(
  select c.tx_id, c.event_id from ${outboxCursors} c
  where not exists (select 1 from ${outboxCursors} where ${aheadOfCluster})
  order by c.tx_id, c.event_id
  limit 1)`;

/** A cursor no consumer of this process has, that has not moved for this long, is reported as stale. */
const staleCursor = sql`interval '7 days'`;

/**
 * The outbox_cursors row that holds the outbox prune once it has seen a cursor ahead of this
 * cluster. It stays when the cluster's ids later pass the restored cursors: the events written in
 * that gap sort before every cursor, so no consumer has read them, and nothing would show it. Its
 * cursor is the beginning, so it also holds the boundary by itself. Only an operator deletes it,
 * once the restore is repaired or every consumer has read past the gap (deploy/README.md). No
 * consumer may have this name.
 */
export const pruneHold = 'remote.prune.hold';

/**
 * Deletes up to one batch of handled outbox events older than `cutoff`, under the cursor creation
 * lock (outbox/worker.ts). Nothing while a consumer of this process has no cursor yet (the worker
 * creates them at start) or the hold is set (warned each run; set here the first time a cursor is
 * ahead of this cluster). A cursor this process does not run that has not moved in 7 days holds
 * the boundary back for good (a renamed or removed consumer's row), so it is warned about each run.
 */
async function pruneOutbox(q: OpenTx['db'], consumers: readonly string[], cutoff: string, limit: number, warnings: string[]) {
  if (consumers.length === 0) return [];
  await q.execute(cursorCreationLock);
  const names = nameList(consumers);
  const [state] = await q.execute<{ ahead: string[]; missing: string[]; stale: string[]; hold: { since: string; why: string } | null }>(sql`
    select
      array(select consumer from ${outboxCursors} where ${aheadOfCluster} order by consumer) as ahead,
      array(select n from unnest(${names}) n where not exists (select 1 from ${outboxCursors} c where c.consumer = n) order by n) as missing,
      array(
        select consumer from ${outboxCursors}
        where consumer <> all(${names}) and consumer <> ${pruneHold} and updated_at < now() - ${staleCursor}
        order by consumer) as stale,
      (select json_build_object('since', updated_at, 'why', last_error) from ${outboxCursors} where consumer = ${pruneHold}) as hold`);
  if (!state) return [];
  let hold = state.hold;
  if (!hold && state.ahead.length > 0) {
    const why = `cursor ${state.ahead.join(', ')} was ahead of this database's transaction ids (restored onto another cluster?)`;
    const [set] = await q
      .insert(outboxCursors)
      .values({ consumer: pruneHold, txId: '0', eventId: 0, lastError: why })
      .onConflictDoNothing()
      .returning({ since: outboxCursors.updatedAt });
    hold = { since: (set?.since ?? new Date()).toISOString(), why };
  }
  if (hold) {
    warnings.push(
      `outbox prune: held since ${hold.since}: ${hold.why}; no outbox event is deleted until an operator deletes the ${pruneHold} row of outbox_cursors (deploy/README.md)`,
    );
    return [];
  }
  if (state.stale.length > 0) {
    warnings.push(
      `outbox prune: cursor ${state.stale.join(', ')} has not moved in 7 days and no consumer of this worker has that name; it holds outbox retention back (if the consumer was renamed or removed, delete its outbox_cursors row: deploy/README.md)`,
    );
  }
  if (state.missing.length > 0) return [];
  // The oldest batch of handled events (the outbox_order index, from its start), then only those
  // older than the window: a run ends at the first short batch, so it never walks the retained
  // events looking for old ones (created_at has no index). created_at is the transaction's start,
  // so an event of a transaction that ran long before it wrote sits behind newer events in this
  // order and goes only once the batch before it has expired too: late, never early.
  // `= any(array(...))` keeps the DELETE on the primary key; `in (...)` planned a scan of the
  // whole table. The count of registered cursors is uncorrelated, so it runs once (an InitPlan).
  // outbox_skipped is looked up by event_id, the second column of its key: a scan of that index
  // per candidate, and a batch walks past every skipped event at the start of the order. Fine
  // while it is near empty (no row in production on 2026-11-18); if poison skips pile up into the
  // thousands, an index on outbox_skipped (event_id) is the fix.
  return q.execute<{ id: string }>(sql`
    delete from ${outbox}
    where id = any(array(
      select id from ${outbox} o
      where (o.tx_id, o.id) <= ${slowestCursor}
        and not exists (select 1 from ${outboxSkipped} s where s.event_id = o.id)
      order by o.tx_id, o.id
      limit ${limit} for update skip locked))
      and created_at < ${cutoff}::timestamptz
      and (select count(*) from ${outboxCursors} where consumer = any(${names})) = ${consumers.length}
    returning id`);
}

/**
 * Deletes up to one batch of rows older than the grant's table keeps; returns how many went. The
 * candidates are claimed with FOR UPDATE SKIP LOCKED, so a row another transaction is changing
 * (the inbox job putting a skipped row back to pending) is left, and the DELETE states the
 * conditions again, so a row that stopped qualifying between the two steps is kept. A remote
 * `activities` row stored before the pipeline stopped keeping them loses its link to the deleted
 * bytes (ON DELETE SET NULL); nothing reads it.
 */
export const pruneBatch = defineMutation({
  action: 'remote.prune',
  emits: ['remote.pruned'],
  /**
   * `consumers`: the outbox consumers this process runs (prune-run.ts); with none, the outbox keeps
   * every row. `warnings`: what holds the outbox prune back, for the run to log once.
   */
  async run(t, grant, input: { now: Date; consumers?: readonly string[] }) {
    const { table } = grant.subject;
    const cutoff = new Date(input.now.getTime() - keepMs(table)).toISOString();
    const limit = retention.batch;
    const warnings: string[] = [];
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
        case 'outbox':
          return pruneOutbox(t.db, [...new Set(input.consumers ?? [])], cutoff, limit, warnings);
      }
    })();
    if (gone.length > 0) await t.emit({ type: 'remote.pruned', v: 1, table, rows: gone.length });
    return { rows: gone.length, warnings };
  },
});
