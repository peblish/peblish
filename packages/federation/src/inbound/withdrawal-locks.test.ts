import { eq, sql, type SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, hosts, PUBLIC } from './test-support.ts';

// A withdrawal and an ordinary edit of the same post or comment, interleaved in the order that
// deadlocked when the withdrawal locked the content row before its delete's recheck locked the
// community: a third connection holds the content row, the withdrawal queues for it first, the
// edit second, then the row is let go. Both now take community, post, comment in that order
// (authz/state.ts), so neither aborts, and the outcome is one of the two legal serial orders.

vi.setConfig({ testTimeout: 60_000 });

const lemmy = 'https://lemmy.test';
const { spike, lemmyuser, t1 } = hosts;
const followers = `${lemmyuser}/followers`;
const held = '2026-11-12T12:00:00Z';
const withdrawn = '2026-11-12T12:15:00Z';
const edited = '2026-11-12T12:30:00Z';

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));
const update = (object: Record<string, unknown>, to: string[]) => ({
  id: activityId(lemmy, 'update'),
  type: 'Update',
  actor: lemmyuser,
  object: { ...object, to },
  to,
  audience: spike,
});
const ledgerRows = async () => (await db().select().from(deletionLedger)).length;

/** Holds `lock` (a row lock) on a connection of its own until released. */
async function hold(lock: SQL) {
  let release!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const done = writer().transaction(async (t) => {
    await t.execute(lock);
    locked();
    await released;
  });
  await ready;
  return async () => {
    release();
    await done;
  };
}

/** Waits until `n` backends of this database are waiting on a lock. */
const waiting = (n: number) =>
  vi.waitFor(
    async () => {
      const [row] = await db().execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      expect(row?.n).toBeGreaterThanOrEqual(n);
    },
    { timeout: 20_000, interval: 25 },
  );

/** The withdrawal queues for the held row first, the edit second; then the row is let go. */
async function interleave(lock: SQL, withdrawal: Record<string, unknown>, edit: Record<string, unknown>) {
  const release = await hold(lock);
  const first = deliver(withdrawal);
  await waiting(1);
  const second = deliver(edit);
  await waiting(2);
  await release();
  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    expect(result.status).toBe('fulfilled');
    if (result.status !== 'fulfilled') continue;
    expect(result.value.stored?.error ?? '').not.toMatch(/deadlock/i);
    expect(['applied', 'skipped']).toContain(result.value.stored?.state);
  }
}

describe('a withdrawal and an edit of the same content at once do not deadlock', () => {
  test('a post', async () => {
    const page = (name: string, updated: string) => ({
      id: t1,
      type: 'Page',
      attributedTo: lemmyuser,
      name,
      content: `<p>${name}</p>`,
      updated,
      audience: spike,
    });
    expect((await deliver(update(page('Held', held), [spike, PUBLIC]))).stored?.state).toBe('applied');
    await interleave(
      sql`select 1 from posts where id = ${world.t1.id} for no key update`,
      update(page('Withdrawn', withdrawn), [spike, followers]),
      update(page('Edited', edited), [spike, PUBLIC]),
    );
    const [post] = await db().select().from(posts).where(eq(posts.id, world.t1.id));
    // Withdrawal then edit: removed, and the edit refused on the removed post. Edit then
    // withdrawal: edited, and the older withdrawal ignored.
    const outcome = post?.deletedAt ? { removed: true, ledger: await ledgerRows() } : { title: post?.title, ledger: await ledgerRows() };
    expect([
      { removed: true, ledger: 1 },
      { title: 'Edited', ledger: 0 },
    ]).toContainEqual(outcome);
  });

  test('a comment', async () => {
    const seeded = await seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/91`, local: false });
    const note = (text: string, updated: string) => ({
      id: seeded.apId,
      type: 'Note',
      attributedTo: lemmyuser,
      inReplyTo: t1,
      content: `<p>${text}</p>`,
      updated,
      audience: spike,
    });
    expect((await deliver(update(note('held', held), [spike, PUBLIC]))).stored?.state).toBe('applied');
    await interleave(
      sql`select 1 from comments where id = ${seeded.id} for no key update`,
      update(note('withdrawn', withdrawn), [spike, followers]),
      update(note('edited', edited), [spike, PUBLIC]),
    );
    const [comment] = await db().select().from(comments).where(eq(comments.id, seeded.id));
    const outcome = comment?.deletedAt
      ? { removed: true, ledger: await ledgerRows() }
      : { edited: comment?.contentHtml?.includes('edited') ?? false, ledger: await ledgerRows() };
    expect([
      { removed: true, ledger: 1 },
      { edited: true, ledger: 0 },
    ]).toContainEqual(outcome);
  });
});
