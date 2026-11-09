import { newObjectApId } from '@peblish/schema/actor-urls';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import type { WriteTx } from '../db/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { retryDue } from './retry.ts';

// Owned by lane FED-A. Follows between actors; a follow of a remote community is pending until
// its Accept arrives (lane FED-B calls acceptFollow, removeFollow and receiveFollow from the
// inbox), and the delivery consumer turns the events into Follow, Accept and Undo(Follow).

/** Whether each actor is local, by id. */
async function localFlags(db: WriteTx, ...ids: string[]): Promise<Map<string, boolean>> {
  const rows = await db.select({ id: actors.id, local: actors.local }).from(actors).where(inArray(actors.id, ids));
  return new Map(rows.map((row) => [row.id, row.local]));
}

/** A new Follow activity id. */
async function newFollowId(db: WriteTx): Promise<string> {
  return newObjectApId((await localInstance(db)).origin, 'activity', uuidv7());
}

/**
 * A local person follows a community. A local community accepts at once; a remote one is
 * pending, the Follow is sent, and the retry job (follows/job.ts) sends it again when no Accept
 * comes back. Following twice changes nothing.
 */
export const requestFollow = defineMutation({
  action: 'follow.request',
  emits: ['follow.requested', 'follow.accepted'],
  // A ban, or a community removed, can land after authorize().
  recheck: true,
  async run(t, grant, _input: void) {
    const followerId = grant.actorId;
    const followeeId = grant.subject.communityId;
    const current = () =>
      t.db
        .select({ id: follows.id, state: follows.state })
        .from(follows)
        .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)));
    const [existing] = await current();
    if (existing) return { followId: existing.id, state: existing.state, created: false };
    const flags = await localFlags(t.db, followerId, followeeId);
    const followeeLocal = flags.get(followeeId) === true;
    const apId = await newFollowId(t.db);
    const now = new Date();
    const [created] = await t.db
      .insert(follows)
      .values({
        followerId,
        followeeId,
        apId,
        state: followeeLocal ? 'accepted' : 'pending',
        sentAt: followeeLocal ? null : now,
        acceptedAt: followeeLocal ? now : null,
      })
      .onConflictDoNothing()
      .returning({ id: follows.id, state: follows.state });
    // A concurrent request for the same follow won the insert, and emitted the event.
    if (!created) {
      const [winner] = await current();
      if (!winner) throw new Error('the follow was neither inserted nor found');
      return { followId: winner.id, state: winner.state, created: false };
    }
    const event = { v: 1, followId: created.id, apId, followerId, followeeId, followerLocal: true, followeeLocal } as const;
    await t.emit(followeeLocal ? { type: 'follow.accepted', ...event } : { type: 'follow.requested', ...event });
    return { followId: created.id, state: created.state, created: true };
  },
});

/**
 * A remote community accepted our Follow: the pending row (matched by the Follow id, the local
 * follower and the accepting community, all in the policy) becomes accepted. An Accept for a
 * follow already accepted changes nothing.
 */
export const acceptFollow = defineMutation({
  action: 'follow.accept',
  emits: ['follow.accepted'],
  async run(t, grant, _input: void) {
    const [row] = await t.db.select().from(follows).where(eq(follows.apId, grant.subject.followApId)).for('no key update');
    if (!row?.apId) return { accepted: false };
    if (row.state === 'accepted') return { accepted: false };
    await t.db.update(follows).set({ state: 'accepted', acceptedAt: new Date() }).where(eq(follows.id, row.id));
    await t.emit({
      type: 'follow.accepted',
      v: 1,
      followId: row.id,
      apId: row.apId,
      followerId: row.followerId,
      followeeId: row.followeeId,
      followerLocal: true,
      followeeLocal: false,
    });
    return { accepted: true };
  },
});

/**
 * Ends a follow: the local follower unfollows, a remote follower's Undo(Follow) arrives, or the
 * followee's Reject does. Nothing federates from here except the local unfollow of a remote
 * community, which the consumer sends as Undo(Follow).
 */
export const removeFollow = defineMutation({
  action: 'follow.remove',
  emits: ['follow.removed'],
  async run(t, grant, _input: void) {
    const { followerId, followeeId, apId } = grant.subject;
    // The Follow id the policy matched is part of the delete: an old Reject or Undo must not
    // delete the newer Follow that a retry put in its place.
    const [row] = await t.db
      .delete(follows)
      .where(
        and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId), apId === null ? undefined : eq(follows.apId, apId)),
      )
      .returning({ id: follows.id, apId: follows.apId });
    if (!row) return { removed: false };
    const flags = await localFlags(t.db, followerId, followeeId);
    await t.emit({
      type: 'follow.removed',
      v: 1,
      followId: row.id,
      apId: row.apId ?? '',
      followerId,
      followeeId,
      followerLocal: flags.get(followerId) === true,
      followeeLocal: flags.get(followeeId) === true,
      by: grant.actorId === followerId ? 'follower' : 'followee',
    });
    return { removed: true };
  },
});

/**
 * A remote actor follows a local community: accepted at once (the consumer sends the Accept). A
 * second Follow from the same actor, with a fresh id (Lemmy sends one per attempt), replaces the
 * stored id and is accepted again, so the Accept always names the Follow it answers.
 */
export const receiveFollow = defineMutation({
  action: 'follow.receive',
  emits: ['follow.accepted'],
  // A ban, or a community removed, can land after authorize().
  recheck: true,
  async run(t, grant, _input: void) {
    const followerId = grant.actorId;
    const followeeId = grant.subject.communityId;
    const apId = grant.subject.followApId;
    const now = new Date();
    const [row] = await t.db
      .insert(follows)
      .values({ followerId, followeeId, apId, state: 'accepted', acceptedAt: now })
      .onConflictDoUpdate({
        target: [follows.followerId, follows.followeeId],
        set: { apId, state: 'accepted', acceptedAt: now, sentAt: null },
      })
      .returning({ id: follows.id });
    if (!row) throw new Error('the follow was neither inserted nor updated');
    await t.emit({
      type: 'follow.accepted',
      v: 1,
      followId: row.id,
      apId,
      followerId,
      followeeId,
      followerLocal: false,
      followeeLocal: true,
    });
    return { followId: row.id };
  },
});

/**
 * Sends a pending Follow again under a fresh id (lemmy.world's first-contact skip: the first
 * Follow to an instance that has never heard of us can be lost). The row keeps its pair and
 * state; ap_id and sent_at change, and follow.requested carries the new id. `now` is passed in
 * so the job and its tests agree on the clock, and the due check is repeated under the row lock,
 * so two workers retrying together send one.
 */
export const retryFollow = defineMutation({
  action: 'follow.retry',
  emits: ['follow.requested'],
  async run(t, grant, input: { now: Date }) {
    const [row] = await t.db.select().from(follows).where(eq(follows.id, grant.subject.followId)).for('no key update');
    if (!row || row.state !== 'pending' || !retryDue(row, input.now)) return { retried: false };
    const apId = await newFollowId(t.db);
    await t.db.update(follows).set({ apId, sentAt: input.now }).where(eq(follows.id, row.id));
    await t.emit({
      type: 'follow.requested',
      v: 1,
      followId: row.id,
      apId,
      followerId: row.followerId,
      followeeId: row.followeeId,
      followerLocal: true,
      followeeLocal: false,
    });
    return { retried: true, apId };
  },
});
