import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@peblish/core/db/read';
import { truncateAll } from '@peblish/core/testing/db';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { backup, clientMajor, databaseName, dropOwnDatabase, restore } from './drill.ts';
import { advanceNeeded, advanceXids, alignOutbox, outboxProbe } from './outbox-order.ts';

// A backup from a cluster further on than the one it is restored into, simulated by seeding
// tx_ids far above this cluster's counter: the restore renumbers them so the events keep their
// order, each consumer keeps the same unread events and new events sort after every cursor. Skips without client tools of the
// server's major version, as drill.test.ts does.

const [server] = await db().execute<{ major: string }>(sql`select current_setting('server_version_num')::int / 10000 as major`);
const tools = Math.min(
  (await clientMajor(process.env.PG_DUMP ?? 'pg_dump')) ?? 0,
  (await clientMajor(process.env.PG_RESTORE ?? 'pg_restore')) ?? 0,
);

/** Each consumer's unread event ids, in the worker's order (outbox/worker.ts, without its horizon). */
const unread = async (q: postgres.Sql) =>
  Object.fromEntries(
    (
      await q<{ consumer: string; ids: string[] }[]>`
        select c.consumer, coalesce(array_agg(o.id::text order by o.tx_id, o.id) filter (where o.id is not null), '{}') as ids
        from outbox_cursors c left join outbox o on (o.tx_id, o.id) > (c.tx_id, c.event_id)
        group by c.consumer`
    ).map((row) => [row.consumer, row.ids.map(Number)]),
  );

/** What a consumer added later at 'beginning' reads: every event, in (tx_id, id) order. */
const fromBeginning = async (q: postgres.Sql) =>
  (await q<{ id: string }[]>`select id::text from outbox where (tx_id, id) > ('0'::xid8, 0) order by tx_id, id`).map((r) => Number(r.id));

const rows = async (q: postgres.Sql) => ({
  events: (await q<{ id: string; tx: string }[]>`select id::text, tx_id::text as tx from outbox order by tx_id, id`).map((r) => [
    Number(r.id),
    Number(r.tx),
  ]),
  cursors: (
    await q<{ consumer: string; tx: string; event: string }[]>`
      select consumer, tx_id::text as tx, event_id::text as event from outbox_cursors order by consumer`
  ).map((r) => [r.consumer, Number(r.tx), Number(r.event)]),
});

describe.skipIf(tools < Number(server?.major))('outbox order after a restore', () => {
  const url = process.env.DATABASE_URL ?? '';
  const source = postgres(url, { max: 1, onnotice: () => undefined });
  const dir = mkdtempSync(join(tmpdir(), 'cutover-order-'));
  const named = (name: string) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.href;
  };
  const restoredUrl = named(`${databaseName(url)}_order`);
  const advancedUrl = named(`${databaseName(url)}_order_up`);
  const refusedUrl = named(`${databaseName(url)}_order_no`);
  const file = join(dir, 'ahead.dump');
  const own: Awaited<ReturnType<typeof restore>>[] = [];
  const admin = postgres(named('postgres'), { max: 1, onnotice: () => undefined });
  const exists = async (name: string) => (await admin`select 1 from pg_database where datname = ${name}`).length > 0;
  const nextXid = async () => BigInt((await source<{ n: string }[]>`select pg_snapshot_xmax(pg_current_snapshot())::text as n`)[0]!.n);
  // Left by a run that stopped early: restore refuses a database that exists.
  beforeAll(async () => {
    for (const name of [restoredUrl, advancedUrl, refusedUrl].map(databaseName))
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
  }, 60_000);
  afterAll(async () => {
    await source`truncate outbox, outbox_cursors`;
    await source.end({ timeout: 5 });
    for (const database of own) await dropOwnDatabase(database);
    await admin.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test(
    'a backup ahead of the cluster is renumbered: the same order, the same unread events per consumer, new events read by all',
    { timeout: 120_000 },
    async () => {
      await truncateAll();
      const next = await nextXid();
      const high = (offset: number) => (next + 1_000_000_000n + BigInt(offset)).toString();
      // Ids out of step with tx_ids, also among events every cursor has passed (11 before 10),
      // three events in the slowest cursor's transaction (one before it, one at it, one after),
      // a cursor between two events of one transaction, and one at a transaction with no events,
      // as a consumer starting at 'now' leaves it.
      const events: [number, number][] = [
        [11, 1],
        [10, 2],
        [1, 5],
        [2, 8],
        [7, 8],
        [9, 8],
        [3, 10],
        [4, 10],
        [5, 10],
        [6, 20],
        [8, 40],
      ];
      for (const [id, offset] of events) {
        await source`
        insert into outbox (id, tx_id, type, v, payload) overriding system value
        values (${id}, ${high(offset)}::xid8, 'test.event', 1, '{}')`;
      }
      await source`select setval(pg_get_serial_sequence('outbox', 'id'), 11)`;
      for (const [consumer, offset, eventId] of [
        ['slow', 8, 7],
        ['tie', 10, 4],
        ['now', 30, 0],
        ['done', 40, 8],
      ] as const) {
        await source`insert into outbox_cursors (consumer, tx_id, event_id) values (${consumer}, ${high(offset)}::xid8, ${eventId})`;
      }
      const before = await unread(source);
      expect(before).toEqual({ slow: [9, 3, 4, 5, 6, 8], tie: [5, 6, 8], now: [8], done: [] });
      const order = await fromBeginning(source);
      expect(order).toEqual([11, 10, 1, 2, 7, 9, 3, 4, 5, 6, 8]);

      await backup(url, file);
      const restoredDb = await restore(file, restoredUrl);
      own.push(restoredDb);
      expect(restoredDb.outbox).toEqual({ renumbered: true, ranked: 8, advanced: 0 });

      const restored = postgres(restoredDb.url, { max: 1, onnotice: () => undefined });
      try {
        // Every value at its rank among the events' and cursors' values.
        expect(await rows(restored)).toEqual({
          events: [
            [11, 1],
            [10, 2],
            [1, 3],
            [2, 4],
            [7, 4],
            [9, 4],
            [3, 5],
            [4, 5],
            [5, 5],
            [6, 6],
            [8, 8],
          ],
          cursors: [
            ['done', 8, 8],
            ['now', 7, 0],
            ['slow', 4, 7],
            ['tie', 5, 4],
          ],
        });
        expect(await unread(restored)).toEqual(before);
        // A consumer added after the backup, with no saved cursor, starts at 'beginning' and reads the original order.
        expect(await fromBeginning(restored)).toEqual(order);
        expect(await outboxProbe(restoredDb.url)).toEqual({ cursorsAhead: 0, idsAhead: 0 });

        // A second run finds nothing to do.
        const once = await rows(restored);
        expect(await alignOutbox(restoredDb.url)).toEqual({ renumbered: false });
        expect(await rows(restored)).toEqual(once);

        // A new event comes after every cursor.
        const [fresh] = await restored<
          { id: string }[]
        >`insert into outbox (type, v, payload) values ('test.event', 1, '{}') returning id::text`;
        const after = await unread(restored);
        for (const consumer of Object.keys(before)) expect(after[consumer]).toEqual([...before[consumer]!, Number(fresh!.id)]);
      } finally {
        await restored.end({ timeout: 5 });
      }
    },
  );

  test(
    'ranks that reach the counter advance it first; past the limit the restore refuses and drops its database',
    { timeout: 120_000 },
    async () => {
      // This cluster's counter is far above any outbox a test can seed, so the ranks start above
      // it, past the transactions pg_restore and other lanes use meanwhile (about 0.1 s to advance).
      const counter = (await nextXid()) + 100_000n;
      const up = await restore(file, advancedUrl, { rankFrom: counter });
      own.push(up);
      if (!up.outbox.renumbered) throw new Error('not renumbered');
      expect(up.outbox.ranked).toBe(8);
      expect(up.outbox.advanced).toBeGreaterThan(0);
      const restored = postgres(up.url, { max: 1, onnotice: () => undefined });
      try {
        const { events } = await rows(restored);
        expect(events.map(([id, tx]) => [id, BigInt(tx!) - counter])).toEqual(
          [
            [11, 1],
            [10, 2],
            [1, 3],
            [2, 4],
            [7, 4],
            [9, 4],
            [3, 5],
            [4, 5],
            [5, 5],
            [6, 6],
            [8, 8],
          ].map(([id, rank]) => [id, BigInt(rank!)]),
        );
        expect(await fromBeginning(restored)).toEqual([11, 10, 1, 2, 7, 9, 3, 4, 5, 6, 8]);
        expect(await outboxProbe(up.url)).toEqual({ cursorsAhead: 0, idsAhead: 0 });
      } finally {
        await restored.end({ timeout: 5 });
      }

      await expect(restore(file, refusedUrl, { rankFrom: (await nextXid()) + 100_000n, maxAdvance: 1 })).rejects.toThrow(
        /more than 1; stop and look/,
      );
      expect(await exists(databaseName(refusedUrl))).toBe(false);
    },
  );

  test('an outbox already behind the counter is left as it is', { timeout: 30_000 }, async () => {
    await truncateAll();
    await source`insert into outbox (type, v, payload) values ('test.event', 1, '{}'), ('test.event', 1, '{}')`;
    await source`insert into outbox_cursors (consumer, tx_id) values ('beginning', '0'), ('now', pg_snapshot_xmin(pg_current_snapshot()))`;
    const before = await rows(source);
    expect(await alignOutbox(url)).toEqual({ renumbered: false });
    expect(await rows(source)).toEqual(before);
  });

  test('the counter is advanced by empty transactions, and a large advance is refused', async () => {
    const next = async () => BigInt((await source<{ n: string }[]>`select pg_snapshot_xmax(pg_current_snapshot())::text as n`)[0]!.n);
    const start = await next();
    await advanceXids(source, 300);
    expect((await next()) - start).toBeGreaterThanOrEqual(300n);
    expect(advanceNeeded(1_000n, 999n, 0)).toBe(0);
    expect(advanceNeeded(1_000n, 1_499n, 500)).toBe(500);
    expect(() => advanceNeeded(1_000n, 1_500n, 500)).toThrow(/advanced by 501, more than 500/);
  });
});
