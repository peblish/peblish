import { localInstance } from '@peblish/core/db/local-instance';
import { actors } from '@peblish/core/db/tables/actors';
import { activities } from '@peblish/core/db/tables/federation';
import { defineConsumer, type ConsumerTx } from '@peblish/core/outbox/consumers';
import type { OutboxEvent } from '@peblish/schema/events';
import { and, desc, eq } from 'drizzle-orm';
import { peerInboxes } from '../delivery/followers.ts';
import { newActivityId, publishInCommunity, sendActivity } from '../delivery/publish.ts';
import { removedBoostedPosts, withdrawBoosts } from '../delivery/withdraw.ts';
import { actorRefs, type ActorRef } from '../delivery/records.ts';
import { accountDeletion, ban, collectionChange, lock, removal, restoration, unban, unlock } from './moderation.ts';

// Outbound moderation (the other half of lane FED-B's relay; announce.ts is the inbound half).
// A moderation action taken on this server (`local` true) is federated to the community's
// remote followers: a removal is a Delete with the reason as its summary, a restoration its
// Undo, a lock is Lock or its Undo, a pin is Add (or Remove) on the featured collection, a ban
// is Block with `expires` and `removeData` or its Undo, a change of moderators is Add or
// Remove on the moderators collection. Each is stored, served at its id and announced by the
// community to its remote followers (delivery/publish.ts). An action a peer took (`local`
// false) already reached its followers through the relay, and an action in a community we do
// not host is ours alone: we cannot command a remote community. A local person's deletion
// becomes a Delete of the account, signed with the key the deleted actor keeps (lane A).

type Of<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>;

async function localCommunity(t: ConsumerTx, communityId: string): Promise<ActorRef | null> {
  const community = (await actorRefs(t.db, [communityId])).get(communityId);
  return community?.local && !community.deleted ? community : null;
}

/** The id of the activity of `type` about `objectApId` we sent last, so its Undo embeds it; a fresh id if none is stored. */
async function sentId(t: ConsumerTx, origin: string, type: string, objectApId: string): Promise<string> {
  const [row] = await t.db
    .select({ apId: activities.apId })
    .from(activities)
    .where(and(eq(activities.type, type), eq(activities.objectApId, objectApId), eq(activities.local, true)))
    .orderBy(desc(activities.createdAt))
    .limit(1);
  return row?.apId ?? newActivityId(origin);
}

/** The community's featured and moderators collections, as its document advertises them. */
async function collections(t: ConsumerTx, communityId: string) {
  const [row] = await t.db
    .select({ apId: actors.apId, featuredUrl: actors.featuredUrl, moderatorsUrl: actors.moderatorsUrl })
    .from(actors)
    .where(eq(actors.id, communityId));
  if (!row) return null;
  return { featured: row.featuredUrl ?? `${row.apId}/featured`, moderators: row.moderatorsUrl ?? `${row.apId}/moderators` };
}

async function onModeration(
  event: Of<'mod.remove' | 'mod.lock' | 'mod.feature' | 'mod.ban' | 'mod.role'>,
  t: ConsumerTx,
  origin: string,
): Promise<void> {
  // A site ban (no community, lane MODF's) and an action of someone no longer here are not federated from here.
  if (!event.local || event.moderatorId === null || event.communityId === null) return;
  const { communityId } = event;
  const community = await localCommunity(t, communityId);
  const moderator = (await actorRefs(t.db, [event.moderatorId])).get(event.moderatorId);
  if (!community || !moderator) return;
  const as = (id: string) => ({ id, actorApId: moderator.apId, communityApId: community.apId });
  const publish = (activity: Parameters<typeof publishInCommunity>[2], microblog?: { withdraw: string }) =>
    publishInCommunity(t, { origin, author: moderator, community }, activity, { microblog });
  const id = newActivityId(origin);
  switch (event.type) {
    case 'mod.remove':
      // Mastodon-like followers cannot be told of a restoration: Mastodon keeps a Tombstone of what it deleted.
      return event.removed
        ? publish(
            removal(as(id), event.targetApId, event.reason),
            event.target.kind === 'post' ? { withdraw: event.targetApId } : undefined,
          )
        : publish(restoration(as(id), await sentId(t, origin, 'Delete', event.targetApId), event.targetApId, event.reason));
    case 'mod.lock':
      return publish(
        event.locked ? lock(as(id), event.targetApId) : unlock(as(id), await sentId(t, origin, 'Lock', event.targetApId), event.targetApId),
      );
    case 'mod.feature': {
      const urls = await collections(t, community.id);
      if (event.scope !== 'community' || !urls) return;
      return publish(collectionChange(as(id), event.featured, event.targetApId, urls.featured));
    }
    case 'mod.ban': {
      const details = {
        objectApId: event.targetApId,
        communityApId: community.apId,
        reason: event.reason,
        removeData: event.removeContent,
        expires: event.expiresAt ? new Date(event.expiresAt) : null,
      };
      await publish(event.banned ? ban(as(id), details) : unban(as(id), await sentId(t, origin, 'Block', event.targetApId), details));
      // A ban with removeContent removes the member's posts without an event each: take their boosts back.
      if (event.banned && event.removeContent) {
        for (const postApId of await removedBoostedPosts(t.db, community, event.targetActorId)) {
          await withdrawBoosts(t, { origin, community, postApId });
        }
      }
      return;
    }
    case 'mod.role': {
      const urls = await collections(t, community.id);
      const person = (await actorRefs(t.db, [event.actorId])).get(event.actorId);
      if (!urls || !person) return;
      return publish(collectionChange(as(id), event.role !== null, person.apId, urls.moderators));
    }
  }
}

async function onAccountDeleted(event: Of<'actor.deleted'>, t: ConsumerTx, origin: string): Promise<void> {
  if (!event.local || event.kind !== 'Person') return;
  const person = (await actorRefs(t.db, [event.actorId])).get(event.actorId);
  if (!person) return;
  await sendActivity(t, person, accountDeletion(newActivityId(origin), person.apId), await peerInboxes(t.db));
}

export const consumer = defineConsumer({
  name: 'federation.relay',
  events: ['mod.remove', 'mod.lock', 'mod.feature', 'mod.ban', 'mod.role', 'actor.deleted'],
  startAt: 'beginning',
  async handle(event, t) {
    const { origin } = await localInstance(t.db);
    if (event.type === 'actor.deleted') return onAccountDeleted(event, t, origin);
    return onModeration(event, t, origin);
  },
});
