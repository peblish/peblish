import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { Refused } from '../tx/refused.ts';
import { tx } from '../tx/tx.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { grantFor, outboxEvents, seedBan, seedCommunityRemoval } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { acceptFollow, receiveFollow, removeFollow, requestFollow, retryFollow } from './follow.ts';
import { followedCommunities, followState } from './read.ts';
import { retryDue } from './retry.ts';
import { retryUnansweredFollows } from './resend.ts';

const minute = 60_000;

async function world() {
  const { instance: here, importer } = await seedLocalInstance();
  const there = await seedInstance('lemmy.test', false);
  const alice = await seedActor(here, 'Person', 'alice');
  const bob = await seedActor(there, 'Person', 'bob');
  const local = await seedActor(here, 'Group', 'news');
  const remote = await seedActor(there, 'Group', 'lab');
  const otherRemote = await seedActor(there, 'Group', 'other');
  const asRemote = (actor: { id: string }) => ({ kind: 'remote' as const, actorId: actor.id, announcedBy: null });
  return { here, there, alice, bob, local, remote, otherRemote, importer, asRemote };
}

const follow = (followerId: string, followeeId: string) =>
  db()
    .select()
    .from(follows)
    .where(eq(follows.followerId, followerId))
    .then((rows) => rows.find((row) => row.followeeId === followeeId));
const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);
const refusal = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => null,
    (error: unknown) => error,
  )) as { reason?: string } | null;

beforeEach(truncateAll);

describe('following a community', () => {
  test('a remote community is pending, with a Follow id and a send time, and the Follow is announced as an event', async () => {
    const w = await world();
    const grant = await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id });
    const result = await requestFollow(grant);
    expect(result).toMatchObject({ state: 'pending', created: true });
    const row = await follow(w.alice.id, w.remote.id);
    expect(row).toMatchObject({ state: 'pending', acceptedAt: null });
    expect(row?.apId).toMatch(/^https:\/\/fed-a\.test\/ap\/activity\/[0-9a-f-]{36}$/);
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(await outboxEvents()).toEqual([
      {
        type: 'follow.requested',
        v: 1,
        followId: row!.id,
        apId: row!.apId,
        followerId: w.alice.id,
        followeeId: w.remote.id,
        followerLocal: true,
        followeeLocal: false,
      },
    ]);
    expect(await followState(w.alice.id, w.remote.id)).toBe('pending');
    expect(await followState(w.alice.id, w.otherRemote.id)).toBe('none');
  });

  test('a local community accepts at once, and asking twice changes nothing', async () => {
    const w = await world();
    const grant = await grantFor('follow.request', localUser(w.alice.id), { communityId: w.local.id });
    expect(await requestFollow(grant)).toMatchObject({ state: 'accepted', created: true });
    expect(await requestFollow(grant)).toMatchObject({ state: 'accepted', created: false });
    expect(await types()).toEqual(['follow.accepted']);
    expect(await followState(w.alice.id, w.local.id)).toBe('accepted');
  });

  test('two requests at once make one follow and one event', async () => {
    const w = await world();
    const grant = await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id });
    const results = await Promise.all([requestFollow(grant), requestFollow(grant), requestFollow(grant)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db().select().from(follows)).toHaveLength(1);
    expect(await types()).toEqual(['follow.requested']);
  });

  test('refusals are exact: a ban, a removed community, a person, nobody', async () => {
    const w = await world();
    await seedBan(w.remote, w.alice);
    await seedCommunityRemoval(w.otherRemote);
    const ask = async (communityId: string) =>
      (await authorize('follow.request', localUser(w.alice.id), { communityId })) as { ok: boolean; reason?: string };
    expect(await ask(w.remote.id)).toEqual({ ok: false, reason: 'community.banned' });
    expect(await ask(w.otherRemote.id)).toEqual({ ok: false, reason: 'community.removed' });
    expect(await ask(w.bob.id)).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await ask('01a1bddf-bc70-7f9f-87f1-968d3195960a')).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await authorize('follow.request', w.asRemote(w.bob), { communityId: w.local.id })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
  });

  test('a ban that lands after authorize() is honoured by the recheck, and nothing is written', async () => {
    const w = await world();
    const grant = await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id });
    await seedBan(w.remote, w.alice);
    const error = await refusal(requestFollow(grant));
    expect(error).toBeInstanceOf(Refused);
    expect(error?.reason).toBe('community.banned');
    expect(await db().select().from(follows)).toHaveLength(0);
    expect(await outboxEvents()).toEqual([]);
  });

  test('the sidebar lists followed communities by name, pending ones marked', async () => {
    const w = await world();
    await requestFollow(await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id }));
    await requestFollow(await grantFor('follow.request', localUser(w.alice.id), { communityId: w.local.id }));
    expect((await followedCommunities(w.alice.id)).map(({ name, state, local }) => ({ name, state, local }))).toEqual([
      { name: 'lab', state: 'pending', local: false },
      { name: 'news', state: 'accepted', local: true },
    ]);
  });
});

describe('the answers that come back', () => {
  async function pendingFollow() {
    const w = await world();
    await requestFollow(await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id }));
    const row = (await follow(w.alice.id, w.remote.id))!;
    return { ...w, row };
  }

  test('an Accept matching the Follow id, the follower and the community makes the follow accepted', async () => {
    const w = await pendingFollow();
    const grant = await grantFor('follow.accept', w.asRemote(w.remote), { followApId: w.row.apId!, followerApId: w.alice.apId });
    expect(await acceptFollow(grant)).toEqual({ accepted: true });
    expect(await acceptFollow(grant)).toEqual({ accepted: false });
    expect(await follow(w.alice.id, w.remote.id)).toMatchObject({ state: 'accepted' });
    expect((await outboxEvents()).at(-1)).toMatchObject({
      type: 'follow.accepted',
      followerLocal: true,
      followeeLocal: false,
      apId: w.row.apId,
    });
  });

  test('an Accept from another community, for an unknown Follow id, or from a local principal changes nothing', async () => {
    const w = await pendingFollow();
    expect(await authorize('follow.accept', w.asRemote(w.otherRemote), { followApId: w.row.apId!, followerApId: w.alice.apId })).toEqual({
      ok: false,
      reason: 'follow.mismatch',
    });
    expect(
      await authorize('follow.accept', w.asRemote(w.remote), {
        followApId: 'https://fed-a.test/ap/activity/nope',
        followerApId: w.alice.apId,
      }),
    ).toEqual({
      ok: false,
      reason: 'target.not_found',
    });
    expect(await authorize('follow.accept', localUser(w.alice.id), { followApId: w.row.apId!, followerApId: w.alice.apId })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await follow(w.alice.id, w.remote.id)).toMatchObject({ state: 'pending' });
  });

  test('an Accept must name the local follower of the stored follow', async () => {
    const w = await pendingFollow();
    const followApId = w.row.apId!;
    const claim = (followerApId: string) => authorize('follow.accept', w.asRemote(w.remote), { followApId, followerApId });
    expect(await claim(w.alice.apId)).toMatchObject({ ok: true });
    // Someone else's id, a remote actor's, or a made-up one: the stored follower is alice.
    for (const followerApId of [w.bob.apId, w.remote.apId, 'https://fed-a.test/ap/u.nobody']) {
      expect(await claim(followerApId), followerApId).toEqual({ ok: false, reason: 'follow.mismatch' });
    }
    // A remote follower's follow is not one of ours to be accepted.
    await receiveFollow(
      await grantFor('follow.receive', w.asRemote(w.bob), {
        communityId: w.local.id,
        followApId: 'https://lemmy.test/activities/follow/9',
      }),
    );
    expect(
      await authorize('follow.accept', w.asRemote(w.local), {
        followApId: 'https://lemmy.test/activities/follow/9',
        followerApId: w.bob.apId,
      }),
    ).toEqual({ ok: false, reason: 'follow.mismatch' });
  });

  test('the Accept policy locks the follow row and leaves the follower’s actor row free', async () => {
    const w = await pendingFollow();
    const subject = { followApId: w.row.apId!, followerApId: w.alice.apId };
    const probe = (table: typeof actors | typeof follows, id: string) =>
      writer().execute(sql`select id from ${table} where id = ${id} for no key update nowait`);
    await tx(async (t) => {
      expect(await authorize('follow.accept', w.asRemote(w.remote), subject, { db: t.db, lock: true })).toMatchObject({ ok: true });
      await expect(probe(actors, w.alice.id)).resolves.toBeDefined();
      await expect(probe(follows, w.row.id)).rejects.toThrow();
    });
  });

  test('a Reject removes the follow only when it names the Follow id and comes from the followee', async () => {
    const w = await pendingFollow();
    const subject = { followerId: w.alice.id, followeeId: w.remote.id };
    expect(await authorize('follow.remove', w.asRemote(w.remote), { ...subject, apId: 'https://fed-a.test/ap/activity/older' })).toEqual({
      ok: false,
      reason: 'follow.mismatch',
    });
    expect(await authorize('follow.remove', w.asRemote(w.otherRemote), { ...subject, apId: w.row.apId })).toEqual({
      ok: false,
      reason: 'follow.mismatch',
    });
    expect(await follow(w.alice.id, w.remote.id)).toBeDefined();
    expect(await removeFollow(await grantFor('follow.remove', w.asRemote(w.remote), { ...subject, apId: w.row.apId }))).toEqual({
      removed: true,
    });
    expect(await follow(w.alice.id, w.remote.id)).toBeUndefined();
    expect((await outboxEvents()).at(-1)).toMatchObject({
      type: 'follow.removed',
      by: 'followee',
      followerLocal: true,
      followeeLocal: false,
    });
  });

  test('unfollowing is by the follower alone, and is announced as the follower’s', async () => {
    const w = await pendingFollow();
    const subject = { followerId: w.alice.id, followeeId: w.remote.id, apId: null };
    expect(await authorize('follow.remove', localUser(w.alice.id), { ...subject, followerId: w.bob.id })).toEqual({
      ok: false,
      reason: 'follow.mismatch',
    });
    await removeFollow(await grantFor('follow.remove', localUser(w.alice.id), subject));
    expect((await outboxEvents()).at(-1)).toMatchObject({ type: 'follow.removed', by: 'follower' });
    expect(await authorize('follow.remove', localUser(w.alice.id), subject)).toEqual({ ok: false, reason: 'target.not_found' });
  });
});

describe('a remote actor following a local community', () => {
  test('is accepted at once, announced for the Accept, and a fresh Follow id replaces the old one', async () => {
    const w = await world();
    const first = { communityId: w.local.id, followApId: 'https://lemmy.test/activities/follow/1' };
    await receiveFollow(await grantFor('follow.receive', w.asRemote(w.bob), first));
    expect(await follow(w.bob.id, w.local.id)).toMatchObject({ state: 'accepted', apId: first.followApId });
    await receiveFollow(
      await grantFor('follow.receive', w.asRemote(w.bob), { ...first, followApId: 'https://lemmy.test/activities/follow/2' }),
    );
    expect(await db().select().from(follows)).toHaveLength(1);
    expect(await follow(w.bob.id, w.local.id)).toMatchObject({ apId: 'https://lemmy.test/activities/follow/2' });
    expect(await outboxEvents()).toMatchObject([
      { type: 'follow.accepted', followerLocal: false, followeeLocal: true, apId: first.followApId },
      { type: 'follow.accepted', followerLocal: false, followeeLocal: true, apId: 'https://lemmy.test/activities/follow/2' },
    ]);
  });

  test('a ban that lands after authorize() is honoured by the recheck, and nothing is written', async () => {
    const w = await world();
    const grant = await grantFor('follow.receive', w.asRemote(w.bob), {
      communityId: w.local.id,
      followApId: 'https://lemmy.test/activities/follow/1',
    });
    await seedBan(w.local, w.bob);
    const error = await refusal(receiveFollow(grant));
    expect(error).toBeInstanceOf(Refused);
    expect(error?.reason).toBe('community.banned');
    expect(await db().select().from(follows)).toHaveLength(0);
    expect(await outboxEvents()).toEqual([]);
  });

  test('is refused for a remote community, a community they are banned from, or a local principal', async () => {
    const w = await world();
    await seedBan(w.local, w.bob);
    const followApId = 'https://lemmy.test/activities/follow/1';
    expect(await authorize('follow.receive', w.asRemote(w.bob), { communityId: w.local.id, followApId })).toEqual({
      ok: false,
      reason: 'community.banned',
    });
    expect(await authorize('follow.receive', w.asRemote(w.bob), { communityId: w.remote.id, followApId })).toEqual({
      ok: false,
      reason: 'target.not_found',
    });
    expect(await authorize('follow.receive', localUser(w.alice.id), { communityId: w.local.id, followApId })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
  });
});

describe('the first-contact retry', () => {
  async function pending() {
    const w = await world();
    await requestFollow(await grantFor('follow.request', localUser(w.alice.id), { communityId: w.remote.id }));
    const first = (await follow(w.alice.id, w.remote.id))!;
    return { ...w, first, at: (minutes: number) => new Date(first.createdAt.getTime() + minutes * minute) };
  }

  test('the schedule: due at 5 minutes and again at 15, never after', () => {
    const createdAt = new Date('2026-11-09T10:00:00Z');
    const at = (minutes: number) => new Date(createdAt.getTime() + minutes * minute);
    expect([4, 5, 10, 14, 15, 30].map((m) => retryDue({ createdAt, sentAt: createdAt }, at(m)))).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([5, 14, 15, 30].map((m) => retryDue({ createdAt, sentAt: at(5.2) }, at(m)))).toEqual([false, false, true, true]);
    expect([15, 40].map((m) => retryDue({ createdAt, sentAt: at(15.2) }, at(m)))).toEqual([false, false]);
  });

  test('an unanswered Follow is sent again under a fresh id at 5 minutes and at 15, and then stays pending', async () => {
    const w = await pending();
    expect(await retryUnansweredFollows(w.at(4))).toBe(0);
    expect(await retryUnansweredFollows(w.at(5.5))).toBe(1);
    const second = (await follow(w.alice.id, w.remote.id))!;
    expect(second.apId).not.toBe(w.first.apId);
    expect(second).toMatchObject({ state: 'pending', sentAt: w.at(5.5), createdAt: w.first.createdAt });

    expect(await retryUnansweredFollows(w.at(5.6))).toBe(0);
    expect(await retryUnansweredFollows(w.at(14))).toBe(0);
    expect(await retryUnansweredFollows(w.at(15.5))).toBe(1);
    const third = (await follow(w.alice.id, w.remote.id))!;
    expect(new Set([w.first.apId, second.apId, third.apId]).size).toBe(3);

    expect(await retryUnansweredFollows(w.at(16))).toBe(0);
    expect(await retryUnansweredFollows(w.at(60))).toBe(0);
    expect((await follow(w.alice.id, w.remote.id))?.state).toBe('pending');
    expect((await outboxEvents()).map((event) => (event as { type: string; apId: string }).apId)).toEqual([
      w.first.apId,
      second.apId,
      third.apId,
    ]);
    expect(await types()).toEqual(['follow.requested', 'follow.requested', 'follow.requested']);
  });

  test('a Reject or Undo authorized for an older Follow id cannot delete the newer Follow a retry put in its place', async () => {
    const w = await pending();
    const subject = { followerId: w.alice.id, followeeId: w.remote.id, apId: w.first.apId };
    const reject = await grantFor('follow.remove', w.asRemote(w.remote), subject);
    expect(await retryUnansweredFollows(w.at(6))).toBe(1);
    expect(await removeFollow(reject)).toEqual({ removed: false });
    const now = (await follow(w.alice.id, w.remote.id))!;
    expect(now).toMatchObject({ state: 'pending' });
    expect(now.apId).not.toBe(w.first.apId);
    expect(await types()).toEqual(['follow.requested', 'follow.requested']);
    // The same Reject naming the id that is stored now does remove it.
    const current = await grantFor('follow.remove', w.asRemote(w.remote), { ...subject, apId: now.apId });
    expect(await removeFollow(current)).toEqual({ removed: true });
  });

  test('an accepted follow, a local community and a removed follow are never sent again', async () => {
    const w = await pending();
    await requestFollow(await grantFor('follow.request', localUser(w.alice.id), { communityId: w.local.id }));
    await acceptFollow(await grantFor('follow.accept', w.asRemote(w.remote), { followApId: w.first.apId!, followerApId: w.alice.apId }));
    expect(await retryUnansweredFollows(w.at(6))).toBe(0);
    await writer().update(follows).set({ state: 'pending' }).where(eq(follows.id, w.first.id));
    await removeFollow(
      await grantFor('follow.remove', localUser(w.alice.id), { followerId: w.alice.id, followeeId: w.remote.id, apId: null }),
    );
    expect(await retryUnansweredFollows(w.at(6))).toBe(0);
  });

  test('two workers retrying together send one Follow', async () => {
    const w = await pending();
    const now = w.at(6);
    const grant = await grantFor('follow.retry', await systemPrincipal(db(), 'scheduled'), { followId: w.first.id });
    const results = await Promise.all([retryFollow(grant, { now }), retryFollow(grant, { now })]);
    expect(results.filter((result) => result.retried)).toHaveLength(1);
    // The request itself, and one resend.
    expect(await types()).toEqual(['follow.requested', 'follow.requested']);
  });
});
