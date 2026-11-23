import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, expect, test, vi } from 'vitest';
import { comments, votes } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { drainNotices, say, seedInboxWorld } from '../testing/seed-e2.ts';
import { localUser } from '../testing/seed.ts';
import { watchThreadAs } from '../watches/watches.ts';
import { readInbox } from './read.ts';

// The inbox describes a page's rows from the snapshot it chose them by: a comment purged after
// the rows are chosen and before they are described cannot leave a row that names its author and
// links a comment the page no longer has. To land the purge exactly there, the inbox's rule is
// made to wait, once its statement has its snapshot, on an advisory lock the purging transaction
// holds; the purge commits while the statement waits. It holds on any pool size, one included.

const gate = vi.hoisted(() => ({ key: 0 }));
vi.mock('./visible.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./visible.ts')>();
  const { sql: raw } = await import('drizzle-orm');
  return {
    ...actual,
    inboxVisible: (viewerId: Parameters<typeof actual.inboxVisible>[0]) =>
      gate.key === 0
        ? actual.inboxVisible(viewerId)
        : raw`(${actual.inboxVisible(viewerId)} and (select count(*) from (select pg_advisory_xact_lock_shared(${gate.key}::bigint)) as waited) = 1)`,
  };
});

vi.setConfig({ testTimeout: 60_000 });
beforeEach(truncateAll);

test('a comment purged while a page is read is described as the page chose it, from the same snapshot', async () => {
  const w = await seedInboxWorld();
  const postId = w.posts.local.normal;
  const watched = await watchThreadAs(localUser(w.people.reader.id), { postId });
  if (!watched.ok) throw new Error(watched.reason);
  const id = await say(w.people.owner, postId, 'Doomed words');
  await drainNotices();

  const key = 4_242_001;
  let purge!: () => void;
  const purgeNow = new Promise<void>((resolve) => (purge = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const purging = writer().transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    held();
    await purgeNow;
    await t.delete(votes).where(eq(votes.commentId, id));
    await t.delete(comments).where(eq(comments.id, id));
  });
  await holding;
  // The observer has a connection of its own: the pools may hold one each, and the purge holds the writer's.
  const observer = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
  gate.key = key;
  const reading = readInbox({ actorId: w.people.reader.id, siteRole: 'user' });
  let page: Awaited<typeof reading> | undefined;
  try {
    // The page's list (the statement that selects whole rows; the counts select count(*)) has its snapshot and waits
    // on the lock: the purge commits now.
    for (let tries = 0; ; tries++) {
      const [row] = await observer<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and l.objid::bigint = ${key} and not l.granted
          and a.datname = current_database() and a.query like 'select "id", "recipient_id"%'`;
      if ((row?.waiting ?? 0) > 0) break;
      if (tries > 400) throw new Error('the inbox list never reached the lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    purge();
    await purging;
    page = await reading;
  } finally {
    // Whatever happened above, nothing stays held: the purge commits, the gate opens, the read ends.
    purge();
    await purging.catch(() => undefined);
    await reading.catch(() => undefined);
    gate.key = 0;
    await observer.end();
  }
  expect(page.items).toMatchObject([{ kind: 'thread_reply', commentId: id, actor: { id: w.people.owner.id }, excerpt: 'Doomed words' }]);
  // The next page, read after the purge, has no such row at all.
  expect((await readInbox({ actorId: w.people.reader.id, siteRole: 'user' })).items).toEqual([]);
});
