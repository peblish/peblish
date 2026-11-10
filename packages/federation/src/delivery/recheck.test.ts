import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { media } from '@peblish/core/db/tables/media';
import { writer } from '@peblish/core/db/write';
import { deliveries } from '@peblish/core/delivery/tables';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedCommunityRemoval, seedComment, seedPost } from '@peblish/core/testing/seed-az';
import { seedActor } from '@peblish/core/testing/seed';
import { seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { enqueueDeliveries } from './queue.ts';
import { sentContent } from './recheck.ts';
import { deliverDue, type DeliveryOptions } from './run.ts';

const inbox = 'https://lemmy.test/inbox';
const quiet: Pick<DeliveryOptions, 'refreshSoftware'> = { refreshSoftware: async () => {} };

beforeEach(truncateAll);

async function world() {
  const { instance } = await seedLocalInstance();
  const author = await seedActor(instance, 'Person', 'author');
  const community = await seedActor(instance, 'Group', 'news');
  await seedSigningKey(author);
  await seedSigningKey(community);
  const post = await seedPost(instance, community, author);
  const comment = await seedComment(instance, post, author);
  let n = 0;
  /** Queues `activity` from `sender` and sends it once against a peer that answers 503, so it waits for a retry. */
  const queueAndFailOnce = async (sender: { id: string }, activity: Record<string, unknown>) => {
    const activityApId = `https://fed-a.test/activities/${++n}`;
    const body = JSON.stringify({ id: activityApId, ...activity });
    await tx((t) => enqueueDeliveries(t, { activityApId, senderId: sender.id, body, inboxes: [inbox] }));
    expect(await deliverDue({ fetch: stubFetch({ [inbox]: { status: 503 } }).fetch, ...quiet })).toMatchObject({ retried: 1 });
    return activityApId;
  };
  /** Makes every pending row due and sends it against a peer that takes everything. */
  const retry = async () => {
    await writer()
      .update(deliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: null });
    const stub = stubFetch({ [inbox]: { status: 202 } });
    return { counts: await deliverDue({ fetch: stub.fetch, ...quiet }), sent: stub.requests.map((request) => request.body) };
  };
  const row = async (activityApId: string) => (await db().select().from(deliveries).where(eq(deliveries.activityApId, activityApId)))[0];
  return { instance, author, community, post, comment, queueAndFailOnce, retry, row };
}

test('a queued Create, Update or Announce of content removed since is skipped at its retry; its Delete still goes', async () => {
  const w = await world();
  const page = { type: 'Page', id: w.post.apId, name: 'A post' };
  const create = await w.queueAndFailOnce(w.author, { type: 'Create', actor: w.author.apId, object: page });
  const update = await w.queueAndFailOnce(w.author, { type: 'Update', actor: w.author.apId, object: page });
  const announce = await w.queueAndFailOnce(w.community, {
    type: 'Announce',
    actor: w.community.apId,
    object: { type: 'Create', id: 'https://fed-a.test/activities/inner', object: page },
  });
  const bare = await w.queueAndFailOnce(w.community, { type: 'Announce', actor: w.community.apId, object: page });

  await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, w.post.id));
  const remove = await w.queueAndFailOnce(w.author, { type: 'Delete', actor: w.author.apId, object: w.post.apId });
  const undo = await w.queueAndFailOnce(w.author, {
    type: 'Undo',
    actor: w.author.apId,
    object: { type: 'Like', id: 'https://fed-a.test/activities/like', object: w.post.apId },
  });

  const { counts, sent } = await w.retry();
  expect(counts).toEqual({ delivered: 2, retried: 0, failed: 0, skipped: 4 });
  for (const id of [create, update, announce, bare])
    expect(await w.row(id), id).toMatchObject({ state: 'skipped', lastError: 'the content is deleted or removed', lastStatus: null });
  for (const id of [remove, undo]) expect((await w.row(id))?.state, id).toBe('delivered');
  expect(sent.map((body) => JSON.parse(String(body)).type).toSorted()).toEqual(['Delete', 'Undo']);
});

test('an Announce of a comment is judged by the comment, its post and its community', async () => {
  const w = await world();
  const announceNote = (id: string) =>
    w.queueAndFailOnce(w.community, {
      type: 'Announce',
      actor: w.community.apId,
      object: { type: 'Create', id: `https://fed-a.test/activities/inner-${id}`, object: { type: 'Note', id: w.comment.apId } },
    });
  const live = await announceNote('live');
  expect((await w.retry()).counts).toMatchObject({ delivered: 1, skipped: 0 });
  expect((await w.row(live))?.state).toBe('delivered');

  const deleted = await announceNote('deleted');
  await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, w.comment.id));
  expect((await w.retry()).counts).toMatchObject({ delivered: 0, skipped: 1 });
  expect(await w.row(deleted)).toMatchObject({ state: 'skipped', lastError: 'the content is deleted or removed' });

  await writer().update(comments).set({ deletedAt: null }).where(eq(comments.id, w.comment.id));
  const closed = await announceNote('closed');
  await seedCommunityRemoval(w.community);
  expect((await w.retry()).counts).toMatchObject({ delivered: 0, skipped: 1 });
  expect((await w.row(closed))?.state).toBe('skipped');
});

test('content showing an upload the scan quarantined or blocked since is skipped; a clean one goes', async () => {
  const w = await world();
  const image = { id: randomUUID(), kind: 'upload' as const, ownerId: w.author.id, scanState: 'clean' as const };
  await writer().insert(media).values(image);
  const create = () =>
    w.queueAndFailOnce(w.author, {
      type: 'Create',
      actor: w.author.apId,
      object: { type: 'Page', id: w.post.apId, content: `<p><img src="https://fed-a.test/media/${image.id.toUpperCase()}"></p>` },
    });
  const clean = await create();
  expect((await w.retry()).counts).toMatchObject({ delivered: 1 });
  expect((await w.row(clean))?.state).toBe('delivered');
  for (const scanState of ['quarantined', 'blocked'] as const) {
    await writer().update(media).set({ scanState: 'clean' }).where(eq(media.id, image.id));
    const id = await create();
    await writer().update(media).set({ scanState }).where(eq(media.id, image.id));
    expect((await w.retry()).counts, scanState).toMatchObject({ delivered: 0, skipped: 1 });
    expect(await w.row(id)).toMatchObject({ state: 'skipped', lastError: 'the content shows quarantined media' });
  }
});

test('what an activity carries: the object of a Create or Update, an Announce unwrapped to its real object, nothing for the rest', () => {
  const page = { type: 'Page', id: 'https://a.test/post/1' };
  const of = (activity: unknown) => sentContent(JSON.stringify(activity));
  expect(of({ type: 'Create', object: page })).toEqual({ id: page.id, type: 'Page' });
  expect(of({ type: 'Update', object: page })).toEqual({ id: page.id, type: 'Page' });
  expect(of({ type: 'Announce', object: { type: 'Update', id: 'https://a.test/u/1', object: page } })).toEqual({
    id: page.id,
    type: 'Page',
  });
  expect(of({ type: 'Announce', object: page })).toEqual({ id: page.id, type: 'Page' });
  expect(of({ type: 'Announce', object: 'https://a.test/post/1' })).toEqual({ id: page.id, type: null });
  expect(of({ type: 'Update', object: { type: 'Group', id: 'https://a.test/c/news' } })).toEqual({
    id: 'https://a.test/c/news',
    type: 'Group',
  });
  for (const activity of [
    { type: 'Delete', object: page.id },
    { type: 'Undo', object: { type: 'Delete', object: page.id } },
    { type: 'Like', object: page.id },
    { type: 'Announce', object: { type: 'Delete', id: 'https://a.test/d/1', object: page.id } },
    { type: 'Announce', object: { type: 'Create', id: 'https://a.test/c/1' } },
    { type: 'Create' },
  ])
    expect(of(activity), JSON.stringify(activity)).toBeNull();
});
