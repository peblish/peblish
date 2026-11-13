import { eq } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { commentTag, postTag } from '@peblish/core/edge/tags';
import { owedAfterDrain, startDrain } from '@peblish/core/testing/edge-drain';
import { truncateAll } from '@peblish/core/testing/db';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { fetchRemoteObject } from '../remote-fetch/object.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

// The remote takedowns of the edge cache brief, each made through the inbox (or the object
// fetch) as a peer makes it, then the edge purge consumer run through the real outbox worker
// (core testing/edge-drain.ts): the debt it leaves is the proof the takedown reaches the purge.

vi.setConfig({ testTimeout: 60_000 });

const lemmy = 'https://lemmy.test';
const { spike, lab, lemmyuser, t1 } = hosts;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
  await startDrain();
});

const deliver = (json: Record<string, unknown>, routes: Parameters<typeof stubFetch>[0] = {}) =>
  deliverRow(json, (row) => processRow(row, { fetch: stubFetch(routes).fetch }));
const deletedAt = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0]?.deletedAt;
const remoteComment = () =>
  seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/9`, local: false });
const update = (object: Record<string, unknown>, to: string[]) => ({
  id: activityId(lemmy, 'update'),
  type: 'Update',
  actor: lemmyuser,
  object: { attributedTo: lemmyuser, content: '<p>x</p>', audience: spike, to, ...object },
  to,
  audience: spike,
});

test("a remote author's Delete of a post or a comment", async () => {
  const comment = await remoteComment();
  await startDrain();
  const del = (object: string) => ({
    id: activityId(lemmy, 'delete'),
    type: 'Delete',
    actor: lemmyuser,
    object,
    ...addressedToCommunity(spike),
  });
  expect((await deliver(del(comment.apId))).stored?.state).toBe('applied');
  expect((await deliver(del(t1))).stored?.state).toBe('applied');
  expect(await owedAfterDrain()).toEqual([commentTag(comment.id), postTag(world.t1.id)].toSorted());
});

test('a post its server answers 410 for, and a comment it serves as a Tombstone', async () => {
  const comment = await remoteComment();
  await startDrain();
  const fetch = stubFetch({
    [t1]: { status: 410 },
    [comment.apId]: { body: { type: 'Tombstone', id: comment.apId, formerType: 'Note' } },
  }).fetch;
  expect(await fetchRemoteObject(t1, { fetch })).toMatchObject({ status: 'gone', deleted: true });
  expect(await fetchRemoteObject(comment.apId, { fetch })).toMatchObject({ status: 'gone', deleted: true });
  expect(await owedAfterDrain()).toEqual([commentTag(comment.id), postTag(world.t1.id)].toSorted());
});

test('a direct Update that a Create would be refused for: followers-only, NSFL, or a followers-only comment', async () => {
  expect((await deliver(update({ id: t1, type: 'Page', name: 'Now private' }, [spike]))).stored?.state).toBe('applied');
  expect(await deletedAt(t1)).not.toBeNull();
  expect(await owedAfterDrain()).toEqual([postTag(world.t1.id)]);

  await truncateAll();
  world = await seedInboundWorld();
  await startDrain();
  expect((await deliver(update({ id: t1, type: 'Page', name: 'Now NSFL', nsfl: true }, [spike, PUBLIC]))).stored?.state).toBe('applied');
  expect(await deletedAt(t1)).not.toBeNull();
  expect(await owedAfterDrain()).toEqual([postTag(world.t1.id)]);

  const comment = await remoteComment();
  await startDrain();
  expect((await deliver(update({ id: comment.apId, type: 'Note', inReplyTo: t1 }, [spike]))).stored?.state).toBe('applied');
  expect((await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.deletedAt).not.toBeNull();
  expect(await owedAfterDrain()).toEqual([commentTag(comment.id)]);
});

test('an Update that withdraws a post as a poll, and an announced one whose origin copy withdraws it (round 3)', async () => {
  expect((await deliver(update({ id: t1, type: 'Question', name: 'Poll', oneOf: [] }, [spike]))).stored?.state).toBe('applied');
  expect(await owedAfterDrain()).toEqual([postTag(world.t1.id)]);

  const id = 'https://piefed.test/post/43';
  const activity = (type: 'Create' | 'Update', activityId: string, to: string[]) => ({
    id: activityId,
    type,
    actor: hosts.pfuser,
    object: { id, type: 'Page', attributedTo: hosts.pfuser, name: 'P', content: '<p>x</p>', audience: lab, to },
    to,
    cc: [lab],
    audience: lab,
  });
  const announce = (object: Record<string, unknown>) => ({
    id: activityId(lemmy, 'announce'),
    type: 'Announce',
    actor: lab,
    to: [PUBLIC],
    cc: [`${lab}/followers`],
    object,
  });
  const createId = 'https://piefed.test/activities/create/43';
  const created = activity('Create', createId, [lab, PUBLIC]);
  expect((await deliver(announce(created), { [createId]: { body: created } })).stored?.state).toBe('applied');
  const [held] = await db().select().from(posts).where(eq(posts.apId, id));
  await startDrain();
  const updateId = 'https://piefed.test/activities/update/43';
  const { stored } = await deliver(announce(activity('Update', updateId, [lab, PUBLIC])), {
    [updateId]: { body: activity('Update', updateId, [lab, 'https://piefed.test/u/pfuser/followers']) },
  });
  expect(stored?.state).toBe('applied');
  expect(await owedAfterDrain()).toEqual([postTag(held!.id)]);
});
