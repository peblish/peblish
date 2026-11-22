import { parseEvent } from '@peblish/schema/events';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { writer } from '../db/write.ts';
import { db } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents, seedPost } from '../testing/seed-az.ts';
import { declareAge } from '../testing/seed-b1.ts';
import { seedInboxWorld } from '../testing/seed-e2.ts';
import { localUser } from '../testing/seed.ts';
import { threadWatches } from './tables.ts';
import { unwatchThreadAs, watchingAmong, watchThreadAs } from './watches.ts';

// Following a thread (lane f-notify): the two entry points, their policy and the reader hook.

beforeEach(truncateAll);

const watchEvents = async () => (await outboxEvents()).map(parseEvent).filter((event) => event.type.startsWith('watch.'));
const rowsOf = (ownerId: string) => db().select().from(threadWatches).where(eq(threadWatches.ownerId, ownerId));

describe('following and unfollowing', () => {
  test('follows from now on, once; unfollows once; each change emits its event and a repeat emits nothing', async () => {
    const w = await seedInboxWorld();
    const reader = localUser(w.people.reader.id);
    const postId = w.posts.local.normal;
    expect(await watchThreadAs(reader, { postId })).toEqual({ ok: true, watching: true });
    expect(await watchThreadAs(reader, { postId })).toEqual({ ok: true, watching: true });
    expect(await rowsOf(w.people.reader.id)).toEqual([{ ownerId: w.people.reader.id, postId, since: expect.any(Date) }]);
    expect(await unwatchThreadAs(reader, { postId })).toEqual({ ok: true, watching: false });
    expect(await unwatchThreadAs(reader, { postId })).toEqual({ ok: true, watching: false });
    expect(await rowsOf(w.people.reader.id)).toEqual([]);
    expect(await watchEvents()).toEqual([
      { type: 'watch.added', v: 1, ownerId: w.people.reader.id, postId },
      { type: 'watch.removed', v: 1, ownerId: w.people.reader.id, postId },
    ]);
  });

  test('only a post the person may read: live, in an open community, and with a 16+ declaration when sensitive', async () => {
    const w = await seedInboxWorld();
    const reader = localUser(w.people.reader.id);
    const ask = async (postId: string) => {
      const result = await watchThreadAs(reader, { postId });
      return result.ok ? 'ok' : result.reason;
    };
    expect(await ask(w.posts.local.removed)).toBe('target.removed');
    expect(await ask(w.posts.local.deleted)).toBe('target.deleted');
    expect(await ask(w.posts.local['community removed'])).toBe('community.removed');
    expect(await ask(uuidv7())).toBe('target.not_found');
    const sensitive = await seedPost(w.instances.local, w.communities.open, w.people.author, { sensitive: true });
    expect(await ask(sensitive.id)).toBe('target.not_found');
    await declareAge(w.people.reader);
    expect(await ask(sensitive.id)).toBe('ok');
    expect(await watchThreadAs({ kind: 'anonymous' }, { postId: w.posts.local.normal })).toEqual({ ok: false, reason: 'auth.required' });
    expect(await watchEvents()).toHaveLength(1);
  });

  test('unfollowing is always the owner’s, even once the post is removed', async () => {
    const w = await seedInboxWorld();
    await writer().insert(threadWatches).values({ ownerId: w.people.reader.id, postId: w.posts.local.removed });
    expect(await unwatchThreadAs(localUser(w.people.reader.id), { postId: w.posts.local.removed })).toEqual({ ok: true, watching: false });
    expect(await rowsOf(w.people.reader.id)).toEqual([]);
  });
});

describe('owner-only', () => {
  test('a second account can neither read nor change the first’s follows', async () => {
    const w = await seedInboxWorld();
    const first = w.people.reader.id;
    const second = w.people.moderator.id;
    const [normal, locked] = [w.posts.local.normal, w.posts.local.locked];
    await watchThreadAs(localUser(first), { postId: normal });
    await watchThreadAs(localUser(first), { postId: locked });

    // Reading: every post view the second account gets says it follows nothing.
    expect(await watchingAmong(first, [normal, locked])).toEqual(new Set([normal, locked]));
    expect(await watchingAmong(second, [normal, locked])).toEqual(new Set());
    expect(await watchingAmong(null, [normal, locked])).toEqual(new Set());

    // Changing: the second account's unfollow removes nothing of the first's, and its follow adds only its own row.
    expect(await unwatchThreadAs(localUser(second), { postId: normal })).toEqual({ ok: true, watching: false });
    expect(await watchThreadAs(localUser(second), { postId: locked })).toEqual({ ok: true, watching: true });
    expect((await rowsOf(first)).map((row) => row.postId).sort()).toEqual([normal, locked].sort());
    expect((await rowsOf(second)).map((row) => row.postId)).toEqual([locked]);
    const [kept] = await db()
      .select()
      .from(threadWatches)
      .where(and(eq(threadWatches.ownerId, first), eq(threadWatches.postId, normal)));
    expect(kept).toBeDefined();
  });

  test('watchingAmong answers a page of posts at once and none for no posts', async () => {
    const w = await seedInboxWorld();
    await watchThreadAs(localUser(w.people.reader.id), { postId: w.posts.local.normal });
    expect(await watchingAmong(w.people.reader.id, [])).toEqual(new Set());
    expect(await watchingAmong(w.people.reader.id, [w.posts.local.normal, w.posts.local.locked, uuidv7()])).toEqual(
      new Set([w.posts.local.normal]),
    );
  });
});

test("the fan-out reads a post's followers in its own order, earliest follow first, from one index", async () => {
  const [index] = await db().execute<{ def: string }>(sql`select indexdef as def from pg_indexes where indexname = 'thread_watches_post'`);
  expect(index?.def).toBe('CREATE INDEX thread_watches_post ON public.thread_watches USING btree (post_id, since, owner_id)');
});
