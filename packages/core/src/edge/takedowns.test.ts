import type { OutboxEvent } from '@peblish/schema/events';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedPost } from '../testing/seed-az.ts';
import { seedAccount } from '../testing/seed-b1.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { consumer } from './consumer.ts';
import { job } from './job.ts';
import { createPurgeQueue, purgeQueue, setPurgeQueue } from './queue.ts';
import { purgeFor, takedownEvents, type TakedownEvent } from './takedowns.ts';

// The horizon is the oldest transaction anywhere on the shared server, so a busy machine can hold a batch back.
vi.setConfig({ testTimeout: 60_000 });

const zone = '0123456789abcdef0123456789abcdef';
const token = 'tok_' + 'S3cr3t'.repeat(6);

beforeEach(async () => {
  await truncateAll();
  setPurgeQueue(createPurgeQueue({ wide: false }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function world() {
  const local = await seedInstance('feddit.test');
  const author = await seedAccount(local, 'author');
  const community = await seedActor(local, 'Group', 'pics');
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, author);
  return { local, author, community, post, comment };
}

const modBase = { v: 1, moderatorId: null, modlogId: uuidv7(), local: true } as const;
const purge = (event: TakedownEvent) => purgeFor(event, db());

test('each takedown purges what it can name, and the rest purges every public proxy answer', async () => {
  const w = await world();
  const postRef = { postId: w.post.id, communityId: w.community.id, authorId: w.author.id };
  const commentRef = { commentId: w.comment.id, postId: w.post.id, authorId: w.author.id };
  // A post or comment deleted, locally or by a remote Delete.
  for (const local of [true, false]) {
    expect(await purge({ type: 'post.deleted', v: 1, ...postRef, local })).toEqual([`pbm-p-${w.post.id}`]);
    expect(await purge({ type: 'comment.deleted', v: 1, ...commentRef, local })).toEqual([`pbm-c-${w.comment.id}`]);
  }
  // A post or comment removed by a moderator.
  const removal = { type: 'mod.remove', ...modBase, communityId: w.community.id, targetApId: 'x', reason: null, removed: true } as const;
  expect(await purge({ ...removal, target: { kind: 'post', id: w.post.id } })).toEqual([`pbm-p-${w.post.id}`]);
  expect(await purge({ ...removal, target: { kind: 'comment', id: w.comment.id } })).toEqual([`pbm-c-${w.comment.id}`]);
  // A ban that removes content, site-wide or in a community.
  const ban = {
    type: 'mod.ban',
    ...modBase,
    targetActorId: w.author.id,
    targetApId: 'x',
    banned: true,
    removeContent: true,
    expiresAt: null,
    reason: null,
  } as const;
  for (const communityId of [null, w.community.id]) expect(await purge({ ...ban, communityId })).toEqual([`pbm-a-${w.author.id}`]);
  // A person or community deleted.
  for (const actorId of [w.author.id, w.community.id]) {
    expect(await purge({ type: 'actor.deleted', v: 1, actorId, kind: 'Person', local: false })).toEqual([`pbm-a-${actorId}`]);
  }
  // A peer's media quarantined, purged or denied, or the peer blocked (a supplier blocked).
  const peer = { type: 'peer.updated', v: 1, instanceId: uuidv7(), domain: 'lemmy.test', inboxPaused: false, modlogId: uuidv7() } as const;
  for (const change of [
    { media: 'quarantined', blocked: false, purged: false },
    { media: 'denied', blocked: false, purged: true },
    { media: 'approved', blocked: true, purged: false },
  ] as const) {
    expect(await purge({ ...peer, ...change }), change.media).toBe('all');
  }
  // An image hash blocked.
  const listed = { type: 'media.blocklist_changed', v: 1, entryId: uuidv7(), adminId: w.author.id, quarantined: 0 } as const;
  expect(await purge({ ...listed, change: 'added' })).toBe('all');
  // The remote-media kill switch changed.
  const settings = { type: 'settings.updated', v: 1, actorId: w.author.id, modlogId: uuidv7() } as const;
  expect(await purge({ ...settings, keys: ['site.name', 'remote_media.enabled'] })).toBe('all');
});

test('an edit purges once the content stops being public, and a restore, an unban or a loosening purges nothing', async () => {
  const w = await world();
  const postUpdated = {
    type: 'post.updated',
    v: 1,
    postId: w.post.id,
    communityId: w.community.id,
    authorId: w.author.id,
    local: true,
  } as const;
  const communityUpdated = { type: 'actor.updated', v: 1, actorId: w.community.id, kind: 'Group', local: true } as const;
  const personUpdated = { type: 'actor.updated', v: 1, actorId: w.author.id, kind: 'Person', local: true } as const;
  expect(await purge(postUpdated)).toBeNull();
  expect(await purge(communityUpdated)).toBeNull();
  expect(await purge(personUpdated)).toBeNull();
  // An NSFW flag set, on the post or on its community.
  await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, w.post.id));
  expect(await purge(postUpdated)).toEqual([`pbm-p-${w.post.id}`]);
  await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, w.post.id));
  await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, w.community.id));
  expect(await purge(communityUpdated)).toEqual([`pbm-a-${w.community.id}`]);

  const removal = {
    type: 'mod.remove',
    ...modBase,
    communityId: w.community.id,
    targetApId: 'x',
    reason: null,
    removed: false,
    target: { kind: 'post', id: w.post.id },
  } as const;
  expect(await purge(removal)).toBeNull();
  const ban = {
    type: 'mod.ban',
    ...modBase,
    targetActorId: w.author.id,
    targetApId: 'x',
    communityId: null,
    expiresAt: null,
    reason: null,
  } as const;
  expect(await purge({ ...ban, banned: true, removeContent: false })).toBeNull();
  expect(await purge({ ...ban, banned: false, removeContent: true })).toBeNull();
  const peer = { type: 'peer.updated', v: 1, instanceId: uuidv7(), domain: 'lemmy.test', inboxPaused: true, modlogId: uuidv7() } as const;
  expect(await purge({ ...peer, media: 'approved', blocked: false, purged: false })).toBeNull();
  const listed = { type: 'media.blocklist_changed', v: 1, entryId: uuidv7(), adminId: w.author.id, quarantined: 0 } as const;
  expect(await purge({ ...listed, change: 'removed' })).toBeNull();
  expect(await purge({ type: 'settings.updated', v: 1, actorId: w.author.id, modlogId: uuidv7(), keys: ['site.name'] })).toBeNull();
});

/** Runs the consumer through the real outbox worker until its cursor has passed every event. */
async function drain() {
  await ensureCursors([consumer]);
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    await processBatch(consumer);
    const [waiting] = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from outbox o, outbox_cursors c
        where c.consumer = ${consumer.name} and (o.tx_id, o.id) > (c.tx_id, c.event_id)`,
    );
    if (waiting?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the edge purge consumer did not catch up');
}

test('the consumer reads every takedown type, and owes their purges only when edge caching is configured', async () => {
  expect([...consumer.events].toSorted()).toEqual([...takedownEvents].toSorted());
  expect(consumer.startAt).toBe('now');
  const w = await world();
  await ensureCursors([consumer]);
  const deleted: OutboxEvent = {
    type: 'post.deleted',
    v: 1,
    postId: w.post.id,
    communityId: w.community.id,
    authorId: w.author.id,
    local: true,
  };

  // Unconfigured: development, tests and staging owe nothing.
  await tx((t) => t.emit(deleted));
  await drain();
  expect(purgeQueue().owed()).toEqual([]);

  vi.stubEnv('CLOUDFLARE_ZONE_ID', zone);
  vi.stubEnv('CLOUDFLARE_PURGE_TOKEN', token);
  await tx(async (t) => {
    await t.emit(deleted);
    await t.emit({ type: 'comment.deleted', v: 1, commentId: w.comment.id, postId: w.post.id, authorId: w.author.id, local: false });
    // Not a takedown: nothing owed for it.
    await t.emit({ type: 'post.restored', v: 1, postId: w.post.id, communityId: w.community.id, authorId: w.author.id, local: true });
  });
  await drain();
  expect(purgeQueue().owed()).toEqual([`pbm-p-${w.post.id}`, `pbm-c-${w.comment.id}`]);
});

test('the job sends what is owed to Cloudflare, retries it after a failure, and does nothing unconfigured', async () => {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  const answers = [500, 200];
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: answers[0] === 200 }), { status: answers.shift() }));
  vi.stubGlobal('fetch', fetch);
  purgeQueue().add(['pbm-p-1']);
  const signal = new AbortController().signal;
  await job.run(signal);
  expect(fetch).not.toHaveBeenCalled();

  vi.stubEnv('CLOUDFLARE_ZONE_ID', zone);
  vi.stubEnv('CLOUDFLARE_PURGE_TOKEN', token);
  await job.run(signal);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(purgeQueue().owed()).toEqual(['pbm-p-1']);
  // The retry waits out its backoff; past it the same purge goes again and settles.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 21_000);
  await job.run(signal);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(purgeQueue().owed()).toEqual([]);
  expect(lines.join('\n')).not.toContain(token);
});
