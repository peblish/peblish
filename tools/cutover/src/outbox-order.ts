import postgres from 'postgres';
import { CutoverError } from './errors.ts';

// After a restore, the outbox must sort below the transaction counter of the cluster it landed
// on. Events carry the writing transaction's id (tx_id, xid8) and consumers keep cursors
// (tx_id, event_id); the worker reads events after a cursor in (tx_id, id) order, below the
// oldest running transaction (core outbox/worker.ts). A dump keeps the old cluster's ids. On the
// same cluster they are already in the past, but a new cluster's counter starts low, so every new
// event would sort before the restored cursors and every consumer would skip it until the counter
// caught up. `alignOutbox` renumbers in that case only:
// - the events at or before the slowest cursor, which every consumer has passed (and outbox
//   retention deletes), all get tx_id 0 and keep their ids;
// - every other tx_id, of the events after it and of the cursors, gets its rank among those
//   values (1, 2, ...), so each cursor keeps exactly the same events after it, ties included;
// - if the top rank still reaches the cluster's next transaction id, the counter is advanced
//   first with empty transactions (about a million a second and 40 bytes of WAL each, measured
//   on Postgres 17), refused past `maxAdvance`.

/** A connection or a transaction on one. */
type Sql = postgres.Sql | postgres.TransactionSql;

/** Well under autovacuum_freeze_max_age (200 million by default): about 10 s and 400 MB of WAL. */
export const defaultMaxAdvance = 10_000_000;

export type OutboxAlignment =
  | { renumbered: false }
  | {
      renumbered: true;
      /** Events every cursor had passed, now at tx_id 0. */
      passed: number;
      /** Distinct tx_ids of the cursors and the events after the slowest, now 1 to this. */
      ranked: number;
      /** Empty transactions run first so the counter is above the top rank. */
      advanced: number;
    };

/** The next transaction id the cluster will hand out, read without taking one. */
async function nextXid(q: Sql): Promise<bigint> {
  const [row] = await q<{ next: string }[]>`select pg_snapshot_xmax(pg_current_snapshot())::text as next`;
  return BigInt(row!.next);
}

/** How many transaction ids to use up so that `top` sorts below the next one; refuses past `max`. */
export function advanceNeeded(next: bigint, top: bigint, max: number): number {
  const need = top >= next ? Number(top - next + 1n) : 0;
  if (need > max) {
    throw new CutoverError(
      `the restored outbox needs the transaction counter advanced by ${need}, more than ${max}; stop and look before going live`,
    );
  }
  return need;
}

/** Uses up `count` transaction ids, each in an empty transaction of its own. */
export async function advanceXids(q: Sql, count: number): Promise<void> {
  if (count <= 0) return;
  await q.unsafe(`do $$ begin for i in 1..${Math.trunc(count)} loop perform pg_current_xact_id(); commit; end loop; end $$`);
}

/** The slowest cursor as (tx_id, event_id), or null when there is none. */
const slowest = (q: Sql) =>
  q<{ tx_id: string; event_id: string }[]>`
    select tx_id::text, event_id::text from outbox_cursors order by tx_id, event_id limit 1`.then((rows) => rows[0] ?? null);

/** Whether an outbox row is at or before the slowest cursor; false with no cursor. */
const passedBy = (q: Sql, cursor: { tx_id: string; event_id: string } | null) =>
  cursor ? q`(o.tx_id, o.id) <= (${cursor.tx_id}::xid8, ${cursor.event_id}::bigint)` : q`false`;

/** How many distinct tx_ids the cursors and the events after the slowest one hold. */
async function rankedValues(q: Sql): Promise<number> {
  const cursor = await slowest(q);
  const [row] = await q<{ n: number }[]>`
    select count(*)::int as n from (
      select tx_id from outbox_cursors
      union select o.tx_id from outbox o where not ${passedBy(q, cursor)}
    ) v`;
  return row?.n ?? 0;
}

/**
 * Renumbers the outbox of the database `url` names when any event or cursor tx_id is at or above
 * the cluster's next transaction id, in one transaction that checks each cursor still has the
 * same events after it; a second run finds nothing to do. Run it before anything writes there.
 */
export async function alignOutbox(url: string, options: { maxAdvance?: number } = {}): Promise<OutboxAlignment> {
  const q = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const ahead = async () => {
      const [row] = await q<{ ahead: boolean }[]>`
        select exists (select 1 from outbox where tx_id >= pg_snapshot_xmax(pg_current_snapshot()))
          or exists (select 1 from outbox_cursors where tx_id >= pg_snapshot_xmax(pg_current_snapshot())) as ahead`;
      return row?.ahead === true;
    };
    if (!(await ahead())) return { renumbered: false };

    const ranked = await rankedValues(q);
    const advanced = advanceNeeded(await nextXid(q), BigInt(ranked), options.maxAdvance ?? defaultMaxAdvance);
    await advanceXids(q, advanced);

    return await q.begin(async (t) => {
      await t`lock table outbox, outbox_cursors in exclusive mode`;
      const [own] = await t<{ xid: string }[]>`select pg_current_xact_id()::text as xid`;
      const cursor = await slowest(t);
      const passed = passedBy(t, cursor);
      // Each consumer's unread events, to compare afterwards (the worker's order, without its horizon).
      await t`
        create temp table unread_before on commit drop as
        select c.consumer, o.id from outbox_cursors c join outbox o on (o.tx_id, o.id) > (c.tx_id, c.event_id)`;
      await t`create temp table tx_rank (old xid8 primary key, new xid8 not null) on commit drop`;
      await t`
        insert into tx_rank
        select tx_id, (dense_rank() over (order by tx_id))::text::xid8
        from (select tx_id from outbox_cursors union select o.tx_id from outbox o where not ${passed}) v`;
      const [top] = await t<{ n: number }[]>`select count(*)::int as n from tx_rank`;
      if (BigInt(top?.n ?? 0) >= BigInt(own!.xid)) {
        throw new CutoverError(`the restored outbox's top rank ${top?.n} is not below transaction ${own!.xid}; nothing was changed`);
      }
      await t`
        update outbox o set tx_id = case when ${passed} then '0'::xid8 else (select r.new from tx_rank r where r.old = o.tx_id) end`;
      await t`update outbox_cursors c set tx_id = r.new from tx_rank r where r.old = c.tx_id`;
      const [check] = await t<{ changed: number; high: number }[]>`
        select
          (select count(*)::int from (
            (select * from unread_before except
              select c.consumer, o.id from outbox_cursors c join outbox o on (o.tx_id, o.id) > (c.tx_id, c.event_id))
            union all
            (select c.consumer, o.id from outbox_cursors c join outbox o on (o.tx_id, o.id) > (c.tx_id, c.event_id)
              except select * from unread_before)
          ) d) as changed,
          (select count(*)::int from (
            select tx_id from outbox union all select tx_id from outbox_cursors
          ) v where tx_id >= ${own!.xid}::xid8) as high`;
      if (check?.changed !== 0 || check.high !== 0) {
        throw new CutoverError(
          `renumbering the restored outbox changed ${check?.changed} unread events of its consumers or left ${check?.high} tx_ids ahead; nothing was changed`,
        );
      }
      const [count] = await t<{ n: number }[]>`select count(*)::int as n from outbox where tx_id = '0'::xid8`;
      return { renumbered: true as const, passed: count?.n ?? 0, ranked: top?.n ?? 0, advanced };
    });
  } finally {
    await q.end({ timeout: 5 });
  }
}

/**
 * Proof, changing nothing, that a new event in the database `url` names reaches every consumer: in a
 * transaction that is rolled back, it writes one, then counts the cursors not before it and the
 * restored tx_ids not below it. Both are 0 when the outbox fits the cluster.
 */
export async function outboxProbe(url: string): Promise<{ cursorsAhead: number; idsAhead: number }> {
  const q = postgres(url, { max: 1, onnotice: () => undefined });
  const rollback = new Error('probe rolled back');
  let result = { cursorsAhead: -1, idsAhead: -1 };
  try {
    await q
      .begin(async (t) => {
        const [probe] = await t<{ tx_id: string; id: string }[]>`
          insert into outbox (type, v, payload) values ('cutover.probe', 1, '{}') returning tx_id::text, id::text`;
        const [row] = await t<{ cursors_ahead: number; ids_ahead: number }[]>`
          select
            (select count(*)::int from outbox_cursors c
              where not (${probe!.tx_id}::xid8, ${probe!.id}::bigint) > (c.tx_id, c.event_id)) as cursors_ahead,
            (select count(*)::int from (
              select tx_id from outbox where id <> ${probe!.id}::bigint union all select tx_id from outbox_cursors
            ) v where tx_id >= ${probe!.tx_id}::xid8) as ids_ahead`;
        result = { cursorsAhead: row?.cursors_ahead ?? -1, idsAhead: row?.ids_ahead ?? -1 };
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    return result;
  } finally {
    await q.end({ timeout: 5 });
  }
}
