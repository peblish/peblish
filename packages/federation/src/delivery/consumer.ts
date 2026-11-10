import { localInstance } from '@peblish/core/db/local-instance';
import { actors } from '@peblish/core/db/tables/actors';
import { activities } from '@peblish/core/db/tables/federation';
import { defineConsumer, type ConsumerTx } from '@peblish/core/outbox/consumers';
import type { OutboxEvent } from '@peblish/schema/events';
import { communityModerators, modlog } from '@peblish/core/db/tables/moderation';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { accept, create, follow, note, page, remove, undoDelete, undoFollow, undoVote, update, updateActor, vote } from './activities.ts';
import { followerInboxes, peerInboxes } from './followers.ts';
import { newActivityId, publishInCommunity, sendActivity } from './publish.ts';
import { actorRefs, type ActorRef, loadComment, loadPost, localActorRecord, mentionedBefore, mentionsIn, voteTarget } from './records.ts';

// Turns the local things that happened (the outbox events with local content) into the
// activities peers read, stores them in `activities`, and queues them for delivery. It runs in
// the outbox worker's batch transaction and makes no request: the delivery job does (run.ts).
// Remote events (local false) are never ours to send; the inbound relay (lane FED-B) asks for
// those. Moderation events and actor.deleted are FED-B's too.

type Of<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>;

/** The id of the Delete we sent for `objectApId`, so its Undo can embed it; a fresh id if none is stored. */
async function sentDeleteId(t: ConsumerTx, origin: string, objectApId: string, actorApId: string): Promise<string> {
  const [row] = await t.db
    .select({ apId: activities.apId })
    .from(activities)
    .where(
      and(
        eq(activities.type, 'Delete'),
        eq(activities.objectApId, objectApId),
        eq(activities.actorApId, actorApId),
        eq(activities.local, true),
      ),
    )
    .orderBy(desc(activities.createdAt))
    .limit(1);
  return row?.apId ?? newActivityId(origin);
}

async function onPost(event: Of<'post.created' | 'post.updated' | 'post.deleted' | 'post.restored'>, t: ConsumerTx, origin: string) {
  const loaded = event.local ? await loadPost(t.db, origin, event.postId) : null;
  if (!loaded) return;
  const { record, author, community } = loaded;
  const as = (id: string) => ({ id, actorApId: author.apId, communityApId: community.apId });
  const context = { origin, author, community };
  const id = newActivityId(origin);
  switch (event.type) {
    case 'post.created': {
      // A post deleted or removed before we got here is not announced; its Delete follows.
      if (!loaded.live) return;
      const { tags, people } = await mentionsIn(t.db, origin, loaded.bodyMd);
      return publishInCommunity(t, context, create(as(id), page(record)), { page: record, tags, mentions: people });
    }
    case 'post.updated': {
      if (!loaded.live) return;
      const { tags, people } = await mentionsIn(t.db, origin, loaded.bodyMd);
      const earlier = await mentionedBefore(t.db, record.apId);
      return publishInCommunity(t, context, update(as(id), page(record)), { tags, mentions: people, earlier, microblog: 'inner' });
    }
    case 'post.deleted': {
      const earlier = await mentionedBefore(t.db, record.apId);
      return publishInCommunity(t, context, remove(as(id), record.apId), { earlier, microblog: { withdraw: record.apId } });
    }
    case 'post.restored': {
      if (!loaded.live) return;
      const undo = undoDelete(as(id), await sentDeleteId(t, origin, record.apId, author.apId), record.apId);
      return publishInCommunity(t, context, undo, { earlier: await mentionedBefore(t.db, record.apId) });
    }
  }
}

async function onComment(event: Of<'comment.created' | 'comment.updated' | 'comment.deleted'>, t: ConsumerTx, origin: string) {
  const loaded = event.local ? await loadComment(t.db, origin, event.commentId) : null;
  if (!loaded) return;
  const { record, author, community } = loaded;
  const as = { id: newActivityId(origin), actorApId: author.apId, communityApId: community.apId };
  const context = { origin, author, community };
  switch (event.type) {
    case 'comment.created':
    case 'comment.updated': {
      if (!loaded.live) return;
      const { tags, people } = await mentionsIn(t.db, origin, loaded.bodyMd);
      if (event.type === 'comment.created') return publishInCommunity(t, context, create(as, note(record)), { tags, mentions: people });
      const earlier = await mentionedBefore(t.db, record.apId);
      return publishInCommunity(t, context, update(as, note(record)), { tags, mentions: people, earlier });
    }
    case 'comment.deleted':
      return publishInCommunity(t, context, remove(as, record.apId), { earlier: await mentionedBefore(t.db, record.apId) });
  }
}

/**
 * A Like or Dislike, or, when the vote is taken back (value 0), the Undo of the one before. A
 * change of direction is just the new vote: Lemmy and PieFed replace the old one with it, and an
 * Undo sent beside it could arrive after it and take the new vote away.
 */
async function onVote(event: Of<'vote.cast'>, t: ConsumerTx, origin: string) {
  if (!event.local) return;
  const voter = (await actorRefs(t.db, [event.voterId])).get(event.voterId);
  const target = await voteTarget(t.db, event.target);
  if (!voter || !target) return;
  const as = (id: string) => ({ id, actorApId: voter.apId, communityApId: target.community.apId });
  const context = { origin, author: voter, community: target.community };
  if (event.value === 0) {
    if (event.previous === 0 || !event.previousApId) return;
    const previous = { id: event.previousApId, value: event.previous };
    return publishInCommunity(t, context, undoVote(as(newActivityId(origin)), previous, target.apId));
  }
  return publishInCommunity(t, context, vote(as(event.apId ?? newActivityId(origin)), event.value, target.apId));
}

async function onFollow(event: Of<'follow.requested' | 'follow.accepted' | 'follow.removed'>, t: ConsumerTx, origin: string) {
  const refs = await actorRefs(t.db, [event.followerId, event.followeeId]);
  const follower = refs.get(event.followerId);
  const followee = refs.get(event.followeeId);
  if (!follower || !followee || event.apId === '') return;
  const as = (sender: typeof follower, id: string) => ({ id, actorApId: sender.apId, communityApId: null });
  // A local person follows a remote community: the Follow goes to the community's inbox.
  if (event.type === 'follow.requested' && event.followerLocal && !event.followeeLocal) {
    if (followee.inboxUrl) await sendActivity(t, follower, follow(as(follower, event.apId), followee.apId), [followee.inboxUrl]);
    return;
  }
  // A remote actor followed a local community: it answers with an Accept to the follower's own inbox.
  if (event.type === 'follow.accepted' && event.followeeLocal && !event.followerLocal) {
    if (follower.inboxUrl)
      await sendActivity(t, followee, accept(as(followee, newActivityId(origin)), event.apId, follower.apId), [follower.inboxUrl]);
    return;
  }
  // A local person stops following a remote community: Undo(Follow). A Reject from the community needs no answer.
  if (event.type === 'follow.removed' && event.by === 'follower' && event.followerLocal && !event.followeeLocal) {
    if (followee.inboxUrl)
      await sendActivity(t, follower, undoFollow(as(follower, newActivityId(origin)), event.apId, followee.apId), [followee.inboxUrl]);
  }
}

/**
 * Who made a community's latest edit: the local person on its newest `community.update` modlog
 * row (written in the edit's transaction), else its owner or a moderator. The event names no
 * one, so two edits close together may both be sent as the later editor's; both are its staff.
 */
async function communityEditor(t: ConsumerTx, communityId: string): Promise<ActorRef | null> {
  const person = and(eq(actors.local, true), eq(actors.kind, 'Person'), isNull(actors.deletedAt));
  const [edited] = await t.db
    .select({ id: modlog.actorId })
    .from(modlog)
    .innerJoin(actors, eq(actors.id, modlog.actorId))
    .where(and(eq(modlog.action, 'community.update'), eq(modlog.communityId, communityId), person))
    .orderBy(desc(modlog.createdAt))
    .limit(1);
  const [staff] = edited
    ? []
    : await t.db
        .select({ id: communityModerators.moderatorId })
        .from(communityModerators)
        .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
        .where(and(eq(communityModerators.communityId, communityId), person))
        .orderBy(sql`${communityModerators.role} = 'owner' desc`, communityModerators.createdAt)
        .limit(1);
  const id = edited?.id ?? staff?.id;
  return id ? ((await actorRefs(t.db, [id])).get(id) ?? null) : null;
}

/**
 * A local person's profile edit goes out as an Update of its document to every peer. A
 * community's goes out as Lemmy, PieFed and Mbin send theirs: an Update(Group) by the moderator
 * who made it, announced by the community to its threadiverse followers (Lemmy 0.19 reads an
 * Update(Group) whose actor is the Group as a Person and refuses it). Mastodon-like followers
 * drop what an Announce wraps and read an actor's Update only from the actor itself, so they get
 * the community's own Update, as does everyone when the community has no local staff.
 */
async function onActor(event: Of<'actor.updated'>, t: ConsumerTx, origin: string) {
  if (!event.local || (event.kind !== 'Person' && event.kind !== 'Group')) return;
  const [row] = await t.db.select().from(actors).where(eq(actors.id, event.actorId));
  const ref = (await actorRefs(t.db, [event.actorId])).get(event.actorId);
  if (!row || !ref || row.deletedAt) return;
  const record = await localActorRecord(t.db, origin, row);
  if (row.kind !== 'Group') {
    const activity = updateActor({ id: newActivityId(origin), actorApId: row.apId, communityApId: null }, record);
    return sendActivity(t, ref, activity, await peerInboxes(t.db));
  }
  const own = updateActor({ id: newActivityId(origin), actorApId: row.apId, communityApId: row.apId }, record);
  const followers = await followerInboxes(t.db, row.id);
  const editor = await communityEditor(t, row.id);
  if (!editor) return sendActivity(t, ref, own, [...followers.create, ...followers.page]);
  const byEditor = updateActor({ id: newActivityId(origin), actorApId: editor.apId, communityApId: row.apId }, record);
  await publishInCommunity(t, { origin, author: editor, community: ref }, byEditor);
  await sendActivity(t, ref, own, followers.page);
}

export const consumer = defineConsumer({
  name: 'federation.delivery',
  events: [
    'post.created',
    'post.updated',
    'post.deleted',
    'post.restored',
    'comment.created',
    'comment.updated',
    'comment.deleted',
    'vote.cast',
    'follow.requested',
    'follow.accepted',
    'follow.removed',
    'actor.updated',
  ],
  startAt: 'beginning',
  async handle(event, t) {
    const { origin } = await localInstance(t.db);
    switch (event.type) {
      case 'post.created':
      case 'post.updated':
      case 'post.deleted':
      case 'post.restored':
        return onPost(event, t, origin);
      case 'comment.created':
      case 'comment.updated':
      case 'comment.deleted':
        return onComment(event, t, origin);
      case 'vote.cast':
        return onVote(event, t, origin);
      case 'follow.requested':
      case 'follow.accepted':
      case 'follow.removed':
        return onFollow(event, t, origin);
      case 'actor.updated':
        return onActor(event, t, origin);
    }
  },
});
