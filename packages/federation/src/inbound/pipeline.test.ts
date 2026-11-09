import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { posts, votes } from '@peblish/core/db/tables/content';
import { activities, inboxDedupe, inboxRaw } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { deliveries } from '@peblish/core/delivery/tables';
import { outbox } from '@peblish/core/db/tables/outbox';
import { writer } from '@peblish/core/db/write';
import { storeRemoteActor } from '@peblish/core/remote/actors';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedSetting } from '@peblish/core/testing/seed-a';
import { seedAccount } from '@peblish/core/testing/seed-b1';
import { deliverRow, inboxState, seedFollow, seedInboundWorld, seedInboxRow } from '@peblish/core/testing/seed-fed-b';
import { actorDocument, nodeInfoRoutes, rsaKeys, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { importGrant } from '../actors/grants.ts';
import { actorFromWire } from '../mapping/actor.ts';
import { processPending } from './job.ts';
import { fetchesPerRow, memberReserve, processRow, type PipelineOptions } from './pipeline.ts';
import { leasePending, maxAttempts, requeueSkippedFor } from './queue.ts';
import { pipelineTotalBudget, resetKeyFetchBudget, takePipelineFetch } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

const deliver = (json: Record<string, unknown>, options: PipelineOptions = {}) => deliverRow(json, (row) => processRow(row, options));
const lemmy = 'https://lemmy.test';
const { spike, lab, lemmyuser, t1 } = hosts;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const page = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `${lemmy}/post/${id}`,
  type: 'Page',
  attributedTo: lemmyuser,
  name: `Post ${id}`,
  content: '<p>body</p>',
  source: { content: 'body', mediaType: 'text/markdown' },
  published: '2026-11-09T10:00:00Z',
  ...extra,
});
const createPage = (id: string, community: string, extra: Record<string, unknown> = {}) => ({
  id: activityId(lemmy, 'create'),
  type: 'Create',
  actor: lemmyuser,
  object: page(id, { audience: community, to: [community, PUBLIC], ...extra }),
  ...addressedToCommunity(community),
});
const announceBy = (community: string, inner: Record<string, unknown>) => ({
  id: activityId(lemmy, 'announce'),
  type: 'Announce',
  actor: community,
  to: [PUBLIC],
  cc: [`${community}/followers`],
  object: inner,
});
const postCount = async () => (await db().select({ id: posts.id }).from(posts)).length;

describe('dedupe, apply and enqueue are one transaction', () => {
  test('a fault between apply and enqueue leaves no state, and a rerun applies once', async () => {
    const body = createPage('100', spike);
    const failing = deliverRow(body, (row) =>
      processRow(row, {
        afterApply: async () => {
          throw new Error('the process died after the insert');
        },
      }),
    );
    await expect(failing).rejects.toThrow('the process died');
    expect(
      await db()
        .select()
        .from(posts)
        .where(eq(posts.apId, `${lemmy}/post/100`)),
    ).toHaveLength(0);
    expect(await db().select().from(inboxDedupe)).toHaveLength(0);
    expect(await db().select().from(activities)).toHaveLength(0);
    expect(await db().select().from(deliveries)).toHaveLength(0);
    expect((await db().select().from(outbox)).filter((row) => row.type === 'post.created')).toHaveLength(0);

    // The same document again: the row is pending and leased, the rerun is the first apply.
    const first = await deliver(body);
    expect(first.stored).toEqual({ state: 'applied', error: null });
    expect(await postCount()).toBe(3);
    // The follower of !spike on mastodon.test got an Announce; the sender's server did not.
    const queued = await db().select().from(deliveries);
    expect(queued.map((row) => row.inboxUrl)).toEqual(['https://mastodon.test/inbox']);
    // A second copy changes nothing.
    const second = await deliver(body);
    expect(second.stored?.state).toBe('skipped');
    expect(second.stored?.error).toBe('duplicate');
    expect(await postCount()).toBe(3);
    expect(await db().select().from(deliveries)).toHaveLength(1);
  });

  test('a copy that arrives inside two Announces applies once', async () => {
    const create = createPage('101', lab);
    const announced = await deliver(announceBy(lab, create));
    expect(announced.stored).toEqual({ state: 'applied', error: null });
    const again = await deliver(announceBy(lab, create));
    expect(again.stored?.error).toBe('duplicate');
    // The Mastodon copy Lemmy also sends, Announce(Page), is the same post.
    const copy = await deliver(announceBy(lab, create.object));
    expect(copy.stored?.error).toMatch(/^object\.exists/);
    expect((await db().select().from(posts)).filter((post) => post.apId === `${lemmy}/post/101`)).toHaveLength(1);
    // Applied inside an Announce, it is a remote community's business: nothing is relayed.
    expect(await db().select().from(deliveries)).toHaveLength(0);
  });

  test('PieFed’s batched Announce applies each activity inside it', async () => {
    const like = (n: number) => ({
      id: activityId(lemmy, `like${n}`),
      type: 'Like',
      actor: lemmyuser,
      object: n === 1 ? world.t2.apId : `${lemmy}/post/none`,
      audience: lab,
    });
    const row = await deliver(announceBy(lab, like(1)));
    expect(row.stored?.state).toBe('applied');
    await truncateVotes();
    const batch = { ...announceBy(lab, like(1)), object: [like(1), like(2)] };
    const batched = await deliver(batch);
    // One vote counted, one waits for its post: the row is recorded for that post, not as applied.
    expect(batched.stored).toEqual({ state: 'skipped', error: `target.missing ${lemmy}/post/none` });
    expect(await db().select().from(votes)).toHaveLength(1);

    // The post arrives: the row goes back in line, the vote that applied is a duplicate, and the other applies.
    await deliver(announceBy(lab, createPage('none', lab)));
    expect((await inboxState(batched.row.id))?.state).toBe('pending');
    await processPending();
    expect(await inboxState(batched.row.id)).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes)).toHaveLength(2);
  });
});

describe('a batch that waits for several objects', () => {
  test('goes back in line when any of them arrives, whichever comes first', async () => {
    const vote = (n: number, actor: string, object: string) => ({
      id: activityId(lemmy, `like${n}`),
      type: 'Like',
      actor,
      object,
      audience: lab,
    });
    const batch = {
      ...announceBy(lab, vote(0, lemmyuser, world.t2.apId)),
      object: [
        vote(1, lemmyuser, world.t2.apId),
        vote(2, hosts.lemmyadmin, `${lemmy}/post/none1`),
        vote(3, lemmyuser, `${lemmy}/post/none2`),
      ],
    };
    const waiting = await deliver(batch);
    expect(waiting.stored).toEqual({ state: 'skipped', error: `target.missing ${lemmy}/post/none1 ${lemmy}/post/none2` });
    expect(await db().select().from(votes)).toHaveLength(1);

    // The second object arrives first: the row goes back in line, applies what it can and waits for the other.
    await deliver(announceBy(lab, createPage('none2', lab)));
    expect((await inboxState(waiting.row.id))?.state).toBe('pending');
    await processPending();
    expect(await inboxState(waiting.row.id)).toEqual({ state: 'skipped', error: `target.missing ${lemmy}/post/none1` });
    expect(await db().select().from(votes)).toHaveLength(2);

    await deliver(announceBy(lab, createPage('none1', lab)));
    await processPending();
    expect(await inboxState(waiting.row.id)).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes)).toHaveLength(3);
  });

  test('an object whose address only contains another’s does not requeue the row', async () => {
    const vote = { id: activityId(lemmy, 'like'), type: 'Like', actor: lemmyuser, object: `${lemmy}/post/none`, audience: lab };
    const skipped = await deliver(announceBy(lab, vote));
    expect(skipped.stored?.error).toBe(`target.missing ${lemmy}/post/none`);
    expect(await requeueSkippedFor(`${lemmy}/post/non`)).toBe(0);
    expect(await requeueSkippedFor(`${lemmy}/post/none/x`)).toBe(0);
    expect(await requeueSkippedFor(`${lemmy}/post/none`)).toBe(1);
  });
});

async function truncateVotes() {
  await writer().delete(votes);
  await writer().delete(inboxDedupe);
}

describe('rows that cannot be applied', () => {
  test('a document the mapping cannot read fails once and is never tried again', async () => {
    const row = await seedInboxRow(
      JSON.stringify({
        id: activityId(lemmy, 'create'),
        type: 'Create',
        actor: lemmyuser,
        object: { type: 'Page', id: `${lemmy}/post/1` },
      }),
    );
    await processPending();
    const first = await inboxState(row.id);
    expect(first?.state).toBe('failed');
    expect(first?.error).toMatch(/Page/);
    const [afterFirst] = await db().select().from(inboxRaw).where(eq(inboxRaw.id, row.id));
    await processPending();
    const [afterSecond] = await db().select().from(inboxRaw).where(eq(inboxRaw.id, row.id));
    expect(afterSecond?.attempts).toBe(afterFirst?.attempts);
  });

  test('a Question, an Announce of a bare IRI and a type we do not read are skipped with a reason', async () => {
    const question = await deliver({
      id: activityId(lemmy, 'create'),
      type: 'Create',
      actor: lemmyuser,
      object: { id: `${lemmy}/poll/1`, type: 'Question', attributedTo: lemmyuser, name: 'p?' },
      ...addressedToCommunity(spike),
    });
    expect(question.stored?.error).toMatch(/^type\.question/);
    const boost = await deliver({
      id: activityId(lemmy, 'announce'),
      type: 'Announce',
      actor: lab,
      object: `${lemmy}/post/1`,
      to: [PUBLIC],
    });
    expect(boost.stored?.error).toMatch(/^announce\.bare_iri/);
    const move = await deliver({ id: activityId(lemmy, 'move'), type: 'Move', actor: lemmyuser, object: lemmyuser, target: lemmyuser });
    expect(move.stored?.error).toMatch(/^type\.unhandled/);
  });

  test('an activity from a server that is down is tried again later, and fails for good only after many tries', async () => {
    const row = await seedInboxRow(
      JSON.stringify({ id: activityId('https://elsewhere.test', 'like'), type: 'Like', actor: 'https://elsewhere.test/u/x', object: t1 }),
      { attempts: 1 },
    );
    const down = stubFetch({ 'https://elsewhere.test/u/x': { status: 503 } });
    await expect(processRow(row, { fetch: down.fetch })).rejects.toThrow();
    expect((await inboxState(row.id))?.state).toBe('pending');
  });
});

describe('putting skipped rows back in line', () => {
  test('a vote for a post we do not hold yet is applied once the post arrives', async () => {
    const target = `${lemmy}/post/200`;
    const vote = { id: activityId(lemmy, 'dislike'), type: 'Dislike', actor: lemmyuser, object: target, audience: lab };
    const skipped = await deliver(announceBy(lab, vote));
    expect(skipped.stored).toEqual({ state: 'skipped', error: `target.missing ${target}` });
    // The post arrives in its Create: the row that waited for it goes back to pending…
    await deliver(announceBy(lab, createPage('200', lab)));
    expect((await inboxState(skipped.row.id))?.state).toBe('pending');
    // …and the job applies it.
    await processPending();
    expect(await inboxState(skipped.row.id)).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(votes).where(eq(votes.value, -1))).length).toBe(1);
  });

  test('requeueSkippedFor sets the rows waiting for one object back to pending (REM’s backfill calls it)', async () => {
    const target = `${lemmy}/post/201`;
    const skipped = await deliver(
      announceBy(lab, { id: activityId(lemmy, 'like'), type: 'Like', actor: lemmyuser, object: target, audience: lab }),
    );
    const other = await deliver(
      announceBy(lab, { id: activityId(lemmy, 'like'), type: 'Like', actor: lemmyuser, object: `${lemmy}/post/202`, audience: lab }),
    );
    expect(await requeueSkippedFor(target)).toBe(1);
    expect((await inboxState(skipped.row.id))?.state).toBe('pending');
    expect((await inboxState(other.row.id))?.state).toBe('skipped');
  });
});

describe('a community’s answers to our Follow', () => {
  const accept = (follow: string, actor: string, follower = world.alice.apId) => ({
    id: activityId(actor.startsWith(lemmy) ? lemmy : 'https://rogue.test', 'accept'),
    type: 'Accept',
    actor,
    to: [lemmyuser],
    object: { id: follow, type: 'Follow', actor: follower, object: lab },
  });

  test('an Accept or Reject from anyone but the followed community changes nothing', async () => {
    const bob = await seedAccount(world.instances.local, 'bob');
    const followId = 'https://fed-b.test/ap/activity/follow-bob';
    await seedFollow(bob, world.peers.lab, followId, 'pending');
    const state = async () => (await db().select().from(follows).where(eq(follows.apId, followId)))[0]?.state;

    const wrongAccept = await deliver(accept(followId, hosts.mallory));
    expect(wrongAccept.stored).toEqual({ state: 'skipped', error: 'follow.mismatch' });
    const wrongReject = await deliver({ ...accept(followId, hosts.mallory), type: 'Reject' });
    expect(wrongReject.stored).toEqual({ state: 'skipped', error: 'follow.mismatch' });
    // The community's own Accept must also name the follower whose Follow it answers.
    const wrongFollower = await deliver(accept(followId, lab));
    expect(wrongFollower.stored).toEqual({ state: 'skipped', error: 'follow.mismatch' });
    expect(await state()).toBe('pending');

    expect((await deliver(accept(followId, lab, bob.apId))).stored).toEqual({ state: 'applied', error: null });
    expect(await state()).toBe('accepted');
    expect((await deliver({ ...accept(followId, lab, bob.apId), type: 'Reject' })).stored).toEqual({ state: 'applied', error: null });
    expect(await state()).toBeUndefined();
  });

  test('an Accept that names its Follow by IRI only cannot be matched to its follower and is skipped; a Reject by IRI is read', async () => {
    const bob = await seedAccount(world.instances.local, 'bob');
    const followId = 'https://fed-b.test/ap/activity/follow-bob';
    await seedFollow(bob, world.peers.lab, followId, 'pending');
    const bare = { id: activityId(lemmy, 'accept'), type: 'Accept', actor: lab, object: followId, to: [bob.apId] };
    expect((await deliver(bare)).stored).toEqual({ state: 'skipped', error: `accept.unverifiable ${followId}` });
    expect((await db().select().from(follows).where(eq(follows.apId, followId)))[0]?.state).toBe('pending');
    const reject = { ...bare, id: activityId(lemmy, 'reject'), type: 'Reject' };
    expect((await deliver(reject)).stored).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(follows).where(eq(follows.apId, followId))).toEqual([]);
  });

  test('a remote Follow of a local community is accepted, and an Undo(Follow) takes it back', async () => {
    const followId = `${lemmy}/activities/follow/1`;
    const follow = { id: followId, type: 'Follow', actor: lemmyuser, object: spike, to: [spike] };
    expect((await deliver(follow)).stored).toEqual({ state: 'applied', error: null });
    const rows = () => db().select().from(follows).where(eq(follows.apId, followId));
    expect(await rows()).toHaveLength(1);
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: follow, to: [spike] };
    expect((await deliver(undo)).stored).toEqual({ state: 'applied', error: null });
    expect(await rows()).toHaveLength(0);
    // A person is not a community.
    const person = await deliver({ ...follow, id: `${lemmy}/activities/follow/2`, object: world.alice.apId });
    expect(person.stored?.error).toMatch(/^follow\.target_unsupported/);
  });
});

describe('what a remote author may post', () => {
  test('sensitive content is refused by default', async () => {
    const nsfw = await deliver(createPage('300', spike, { sensitive: true }));
    expect(nsfw.stored?.error).toMatch(/^content\.nsfw_rejected/);
    expect(await postCount()).toBe(2);
  });

  test('with remote_nsfw.accepted on, sensitive content is stored and NSFL is still refused', async () => {
    await seedSetting('remote_nsfw.accepted', true);
    expect((await deliver(createPage('301', spike, { sensitive: true }))).stored).toEqual({ state: 'applied', error: null });
    const nsfl = await deliver(createPage('302', spike, { sensitive: true, nsfl: true }));
    expect(nsfl.stored?.error).toMatch(/^content\.nsfw_rejected/);
    expect(await postCount()).toBe(3);
  });

  test('a Create of an id already held under another community is refused with post.id_conflict, not stored twice', async () => {
    const before = await postCount();
    const conflict = await deliver(announceBy(lab, createPage('1', lab)));
    expect(conflict.stored).toEqual({ state: 'skipped', error: 'post.id_conflict' });
    expect(await postCount()).toBe(before);
  });

  test('a community never authors a post, comment or vote: skipped before anything is built', async () => {
    const before = await postCount();
    const create = await deliver({
      ...createPage('301', spike),
      actor: lab,
      object: page('301', { attributedTo: lab, audience: spike, to: [spike, PUBLIC] }),
    });
    expect(create.stored?.error).toMatch(/^actor\.group_cannot_act/);
    const like = await deliver({ id: activityId(lemmy, 'like'), type: 'Like', actor: lab, object: t1, audience: spike });
    expect(like.stored?.error).toMatch(/^actor\.group_cannot_act/);
    expect(await postCount()).toBe(before);
    expect(await db().select().from(votes)).toEqual([]);
  });

  test('a top-level Note to a local community is a post: the title is its first line, the body the whole text', async () => {
    const note = {
      id: 'https://mastodon.test/users/follower/statuses/1',
      type: 'Note',
      attributedTo: world.peers.remoteFollower.apId,
      content: '<p>  </p><p>The first line of the status</p><p>and a second</p>',
      published: '2026-11-09T10:00:00Z',
      to: [PUBLIC],
      cc: [spike, 'https://mastodon.test/users/follower/followers'],
    };
    const created = await deliver({
      id: 'https://mastodon.test/users/follower/statuses/1/activity',
      type: 'Create',
      actor: world.peers.remoteFollower.apId,
      object: note,
      to: [PUBLIC],
      cc: note.cc,
    });
    expect(created.stored).toEqual({ state: 'applied', error: null });
    const [post] = await db().select().from(posts).where(eq(posts.apId, note.id));
    expect(post?.title).toBe('The first line of the status');
    expect(post?.contentHtml).toContain('and a second');
    const stranger = await deliver({
      id: 'https://mastodon.test/users/follower/statuses/2/activity',
      type: 'Create',
      actor: world.peers.remoteFollower.apId,
      object: { ...note, id: 'https://mastodon.test/users/follower/statuses/2', cc: ['https://mastodon.test/users/other'] },
      to: [PUBLIC],
    });
    expect(stranger.stored?.error).toMatch(/^note\.no_local_community/);
  });

  test('an author deletes their post, and the moderator who removed it restores it', async () => {
    const del = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: t1, ...addressedToCommunity(spike) };
    expect((await deliver(del)).stored?.state).toBe('applied');
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.deletedAt).not.toBeNull();
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: del, ...addressedToCommunity(spike) };
    expect((await deliver(undo)).stored?.state).toBe('applied');
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.deletedAt).toBeNull();

    // A moderator appointed here removes it with a reason; the Undo restores it.
    const removal = {
      id: activityId(lemmy, 'delete'),
      type: 'Delete',
      actor: hosts.lemmyadmin,
      object: t1,
      summary: 'spam',
      ...addressedToCommunity(spike),
    };
    expect((await deliver(removal)).stored?.state).toBe('applied');
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.removedAt).not.toBeNull();
    const restore = {
      id: activityId(lemmy, 'undo'),
      type: 'Undo',
      actor: hosts.lemmyadmin,
      object: removal,
      ...addressedToCommunity(spike),
    };
    expect((await deliver(restore)).stored?.state).toBe('applied');
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.removedAt).toBeNull();
  });

  test('a remote account’s own Delete deletes the actor, and nobody else’s does', async () => {
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC] };
    expect((await deliver(own)).stored?.state).toBe('applied');
    expect((await db().select().from(actors).where(eq(actors.apId, lemmyuser)))[0]?.deletedAt).not.toBeNull();
  });

  test('removeData on an account Delete removes its posts with it; without it they stay', async () => {
    const deletedAt = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0]?.deletedAt;
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC] };
    expect((await deliver(own)).stored?.state).toBe('applied');
    expect(await deletedAt(t1)).toBeNull();

    await truncateAll();
    world = await seedInboundWorld();
    expect((await deliver({ ...own, removeData: true })).stored?.state).toBe('applied');
    expect(await deletedAt(t1)).not.toBeNull();
    expect(await deletedAt(world.t2.apId)).not.toBeNull();
  });

  test('Undo of an account’s own Delete brings the actor back; the posts its removal deleted stay deleted', async () => {
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC], removeData: true };
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: own, to: [PUBLIC] };
    const actorRow = async () => (await db().select().from(actors).where(eq(actors.apId, lemmyuser)))[0];
    expect((await deliver(own)).stored?.state).toBe('applied');
    expect((await actorRow())?.deletedAt).not.toBeNull();
    expect((await deliver(undo)).stored).toEqual({ state: 'applied', error: null });
    expect((await actorRow())?.deletedAt).toBeNull();
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.deletedAt).not.toBeNull();
  });

  test('an actor edits its own profile, and an actor that sent a Delete stays deleted', async () => {
    const profile = {
      id: lemmyuser,
      type: 'Person',
      preferredUsername: 'lemmyuser',
      name: 'Lemmy User',
      inbox: `${lemmyuser}/inbox`,
      publicKey: { id: `${lemmyuser}#main-key`, owner: lemmyuser, publicKeyPem: world.peers.lemmyuser.keys.publicKeyPem },
    };
    const update = () => ({ id: activityId(lemmy, 'update'), type: 'Update', actor: lemmyuser, object: profile, to: [PUBLIC] });
    expect((await deliver(update())).stored).toEqual({ state: 'applied', error: null });
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC] };
    expect((await deliver(own)).stored?.state).toBe('applied');
    expect((await deliver(update())).stored).toEqual({ state: 'skipped', error: `target.deleted ${lemmyuser}` });
  });
});

describe('what processing a delivery may fetch', () => {
  test('a follow of a community that is not ours, and an Undo of one, fetch nothing', async () => {
    const probe = stubFetch({});
    const follow = (id: string, object: string) => ({
      id: `${lemmy}/activities/follow/${id}`,
      type: 'Follow',
      actor: lemmyuser,
      object,
      to: [object],
    });
    for (const object of [lab, 'https://fed-b.test/ap/c.nowhere', 'https://elsewhere.test/c/new']) {
      const followed = await deliver(follow('f', object), { fetch: probe.fetch });
      expect(followed.stored?.error).toMatch(/^follow\.target_unsupported/);
      const undone = await deliver(
        { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: follow('f', object), to: [object] },
        { fetch: probe.fetch },
      );
      expect(undone.stored?.error).toMatch(/^follow\.target_unsupported/);
    }
    expect(probe.requests).toEqual([]);
  });

  test('content sent straight to a community we do not hold is unannounced before anything is fetched', async () => {
    const probe = stubFetch({});
    const stranger = 'https://elsewhere.test/c/new';
    const direct = await deliver(createPage('400', stranger), { fetch: probe.fetch });
    expect(direct.stored?.error).toMatch(/^community\.unannounced/);
    const block = await deliver(
      {
        id: activityId(lemmy, 'block'),
        type: 'Block',
        actor: hosts.lemmyadmin,
        object: lemmyuser,
        target: stranger,
        ...addressedToCommunity(stranger),
      },
      { fetch: probe.fetch },
    );
    expect(block.stored?.error).toMatch(/^community\.unannounced/);
    expect(probe.requests).toEqual([]);
  });

  test('a delivery that applies nothing and needs more fetches than its allowance is a failure to retry, not a wait', async () => {
    const probe = stubFetch({});
    // Each member is a post of a stranger's server that does not serve it: one fetch, then a skip.
    const members = Array.from({ length: fetchesPerRow + 10 }, (_, n) => ({
      id: `https://elsewhere.test/post/${n}`,
      type: 'Page',
      attributedTo: `https://elsewhere.test/u/${n}`,
      name: `Post ${n}`,
      audience: lab,
      to: [lab, PUBLIC],
    }));
    const batch = { ...announceBy(lab, members[0]!), object: members };
    const row = await seedInboxRow(JSON.stringify(batch), { activityId: batch.id, activityType: 'Announce', actorApId: lab });
    // No member starts once fewer than memberReserve fetches are left.
    await expect(processRow(row, { fetch: probe.fetch })).rejects.toThrow(/more fetches/);
    expect(probe.requests).toHaveLength(fetchesPerRow - memberReserve + 1);
    expect((await inboxState(row.id))?.state).toBe('pending');
  });

  /** The next claim of a row the pipeline stepped aside from: its wait is over, and the lease raises the attempt count again. */
  async function claimAgain(id: string) {
    await writer().update(inboxRaw).set({ leaseUntil: null }).where(eq(inboxRaw.id, id));
    const [claimed] = await leasePending(1);
    if (claimed?.id !== id) throw new Error('the row was not claimed');
    return claimed;
  }
  const attemptsOf = async (id: string) => (await db().select().from(inboxRaw).where(eq(inboxRaw.id, id)))[0]?.attempts;

  test('a valid batch of 200 activities from new origins completes across claims, and a wait costs no attempt', async () => {
    const fresh = Array.from({ length: 200 }, (_, n) => {
      const host = `origin${n}.test`;
      const author = actorDocument(host, 'author', { publicKeyPem: world.peers.lemmyuser.keys.publicKeyPem });
      const post = page(`${n}`, { id: `https://${host}/post/${n}`, attributedTo: author.id, audience: lab, to: [lab, PUBLIC] });
      return { host, author, post };
    });
    const probe = stubFetch(
      Object.assign(
        {},
        ...fresh.map(({ host, author, post }) => ({
          [post.id]: { body: post },
          [author.id]: { body: author },
          ...nodeInfoRoutes(host, 'lemmy'),
        })),
      ),
    );
    const batch = { ...announceBy(lab, fresh[0]!.post), object: fresh.map(({ post }) => post) };
    const seeded = await seedInboxRow(JSON.stringify(batch), {
      activityId: batch.id,
      activityType: 'Announce',
      actorApId: lab,
      attempts: 0,
    });

    const before = await postCount();
    let claims = 0;
    let settled;
    do {
      claims += 1;
      settled = await processRow(await claimAgain(seeded.id), { fetch: probe.fetch });
      // Applied members stay applied, and every claim made progress without failing.
      if (settled.state === 'pending') expect(await attemptsOf(seeded.id)).toBe(0);
    } while (settled.state === 'pending' && claims < 40);

    expect(settled).toEqual({ state: 'applied', error: null });
    expect(await postCount()).toBe(before + 200);
    // More claims than attempts a row has; the allowance was never the reason to stop.
    expect(claims).toBeGreaterThan(maxAttempts);
    expect(await attemptsOf(seeded.id)).toBe(1);
    // The object, the actor and two NodeInfo reads for each origin, once: no claim fetched a member's data again.
    expect(probe.requests.filter(({ url }) => /^https:\/\/origin\d+\.test\//.test(url))).toHaveLength(800);
  }, 60_000);

  test('a delivery that finds the shared fetch window spent waits for it without losing an attempt', async () => {
    const host = 'late.test';
    const stranger = actorDocument(host, 'someone', { publicKeyPem: world.peers.lemmyuser.keys.publicKeyPem });
    const probe = stubFetch({ [stranger.id]: { body: stranger }, ...nodeInfoRoutes(host, 'lemmy') });
    const vote = { id: activityId(`https://${host}`, 'like'), type: 'Like', actor: stranger.id, object: t1, audience: spike };
    const seeded = await seedInboxRow(JSON.stringify(vote), {
      activityId: vote.id,
      activityType: 'Like',
      actorApId: stranger.id,
      attempts: 0,
    });
    for (let used = 0; used < pipelineTotalBudget; used++) takePipelineFetch(`busy${used}.test`);

    const waiting = await processRow(await claimAgain(seeded.id), { fetch: probe.fetch });
    expect(waiting.state).toBe('pending');
    expect(probe.requests).toEqual([]);
    expect(await attemptsOf(seeded.id)).toBe(0);
    expect((await inboxState(seeded.id))?.state).toBe('pending');

    resetKeyFetchBudget();
    expect(await processRow(await claimAgain(seeded.id), { fetch: probe.fetch })).toEqual({ state: 'applied', error: null });
    expect(await attemptsOf(seeded.id)).toBe(1);
  });
});

describe('an Announce of an Announce', () => {
  test('is skipped before anything is read, so two origins cannot send each other in circles', async () => {
    // lab (lemmy.test) announces rogue.test's Announce, which announces lab's Announce, which names the first again.
    const first = `${lemmy}/activities/announce/a`;
    const second = 'https://rogue.test/activities/announce/b';
    const cycle = {
      id: first,
      type: 'Announce',
      actor: lab,
      to: [PUBLIC],
      object: {
        id: second,
        type: 'Announce',
        actor: hosts.fake,
        to: [PUBLIC],
        object: { id: first, type: 'Announce', actor: lab, to: [PUBLIC], object: second },
      },
    };
    const probe = stubFetch({ [first]: { body: cycle }, [second]: { body: cycle.object } });
    const result = await deliver(cycle, { fetch: probe.fetch });
    expect(result.stored).toEqual({ state: 'skipped', error: `announce.nested ${second}` });
    // The same inside a batched Announce.
    const batched = await deliver({ ...cycle, id: `${lemmy}/activities/announce/c`, object: [cycle.object] }, { fetch: probe.fetch });
    expect(batched.stored?.error).toMatch(/^announce\.nested/);
    expect(probe.requests).toEqual([]);
  });
});

describe('an Update of a community’s profile', () => {
  const group = (publicKeyPem: string) => ({
    id: lab,
    type: 'Group',
    preferredUsername: 'lab',
    name: 'Lab, edited',
    inbox: `${lab}/inbox`,
    publicKey: { id: `${lab}#main-key`, owner: lab, publicKeyPem },
  });
  const updateBy = (actor: string, publicKeyPem: string) => ({
    id: activityId(lemmy, 'update'),
    type: 'Update',
    actor,
    object: group(publicKeyPem),
    to: [PUBLIC],
  });
  const stored = async () => ({
    name: (await db().select().from(actors).where(eq(actors.apId, lab)))[0]?.displayName,
    key: (
      await db()
        .select()
        .from(actorKeys)
        .where(eq(actorKeys.keyId, `${lab}#main-key`))
    )[0]?.publicKeyPem,
  });

  test('sent by a moderator and announced edits the profile but never the key; the community’s own Update changes the key', async () => {
    const attacker = rsaKeys().publicKeyPem;
    const moderator = await deliver(announceBy(lab, updateBy(hosts.lemmyadmin, attacker)));
    expect(moderator.stored).toEqual({ state: 'applied', error: null });
    expect(await stored()).toEqual({ name: 'Lab, edited', key: world.peers.lab.keys.publicKeyPem });

    const own = await deliver(updateBy(lab, attacker));
    expect(own.stored).toEqual({ state: 'applied', error: null });
    expect((await stored()).key).toBe(attacker);
  });

  test('a key the community rotated while a moderator’s announced Update was being applied is not rolled back', async () => {
    const rotated = rsaKeys().publicKeyPem;
    const rotation = actorFromWire({
      ...actorDocument('lemmy.test', 'lab', { kind: 'Group', publicKeyPem: rotated }),
      name: 'Lab',
    });
    let opened!: () => void;
    const rotating = new Promise<void>((resolve) => (opened = resolve));
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    // The rotation holds the community's row, as a refresh of the actor does between its upsert and its commit.
    const rotationTx = tx(async (t) => {
      await storeRemoteActor.within(t, await importGrant('remote.actor_store', { apId: lab }), rotation);
      opened();
      await gate;
    });
    await rotating;

    let finished = false;
    const update = deliver(announceBy(lab, updateBy(hosts.lemmyadmin, rsaKeys().publicKeyPem))).then((done) => {
      finished = true;
      return done;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false);
    commit();
    await rotationTx;
    expect((await update).stored).toEqual({ state: 'applied', error: null });
    expect(await stored()).toEqual({ name: 'Lab, edited', key: rotated });
  });
});

describe('a Delete or an Undo from an actor whose server says it is gone', () => {
  test('is read with the copy we hold, however stale, and does not refetch the actor', async () => {
    await writer()
      .update(actors)
      .set({ fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
      .where(eq(actors.apId, lemmyuser));
    const gone = stubFetch({ [lemmyuser]: { status: 410 } });
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC], removeData: true };
    expect((await deliver(own, { fetch: gone.fetch })).stored).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.deletedAt).not.toBeNull();
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: own, to: [PUBLIC] };
    expect((await deliver(undo, { fetch: gone.fetch })).stored).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(actors).where(eq(actors.apId, lemmyuser)))[0]?.deletedAt).toBeNull();
    expect(gone.requests).toEqual([]);
  });
});
