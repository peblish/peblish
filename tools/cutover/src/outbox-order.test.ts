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
// tx_ids far above this cluster's counter: the restore renumbers them so each consumer keeps the
// same unread events and new events sort after every cursor. Skips without client tools of the
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
  let own: Awaited<ReturnType<typeof restore>> | undefined;
  // Left by a run that stopped early: restore refuses a database that exists.
  beforeAll(async () => {
    const admin = postgres(named('postgres'), { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists "${databaseName(restoredUrl)}" with (force)`);
    await admin.end({ timeout: 5 });
  }, 60_000);
  afterAll(async () => {
    await source`truncate outbox, outbox_cursors`;
    await source.end({ timeout: 5 });
    if (own) await dropOwnDatabase(own);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test(
    'a backup ahead of the cluster is renumbered: same unread events per consumer, new events read by all',
    { timeout: 120_000 },
    async () => {
      await truncateAll();
      const [{ next } = { next: '0' }] = await source<{ next: string }[]>`select pg_snapshot_xmax(pg_current_snapshot())::text as next`;
      const high = (offset: number) => (BigInt(next) + 1_000_000_000n + BigInt(offset)).toString();
      // Ids out of step with tx_ids, three events in the slowest cursor's transaction (one before
      // it, one at it, one after), a cursor between two events of one transaction, and one at a
      // transaction with no events, as a consumer starting at 'now' leaves it.
      const events: [number, number][] = [
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
      await source`select setval(pg_get_serial_sequence('outbox', 'id'), 9)`;
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

      const file = join(dir, 'ahead.dump');
      await backup(url, file);
      own = await restore(file, restoredUrl);
      expect(own.outbox).toEqual({ renumbered: true, passed: 3, ranked: 5, advanced: 0 });

      const restored = postgres(own.url, { max: 1, onnotice: () => undefined });
      try {
        // The passed events at 0, every other value at its rank.
        expect(await rows(restored)).toEqual({
          events: [
            [1, 0],
            [2, 0],
            [7, 0],
            [9, 1],
            [3, 2],
            [4, 2],
            [5, 2],
            [6, 3],
            [8, 5],
          ],
          cursors: [
            ['done', 5, 8],
            ['now', 4, 0],
            ['slow', 1, 7],
            ['tie', 2, 4],
          ],
        });
        expect(await unread(restored)).toEqual(before);
        expect(await outboxProbe(own.url)).toEqual({ cursorsAhead: 0, idsAhead: 0 });

        // A second run finds nothing to do.
        const once = await rows(restored);
        expect(await alignOutbox(own.url)).toEqual({ renumbered: false });
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
