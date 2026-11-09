import { randomUUID } from 'node:crypto';
import { activities } from '@peblish/core/db/tables/federation';
import type { OpenTx } from '@peblish/core/tx/tx';
import { newObjectApId } from '@peblish/schema/actor-urls';
import { toWire } from '../mapping/document.ts';
import type { Json, JsonObject } from '../mapping/json.ts';
import type { Activity, ContentObject, PostRecord } from '../mapping/records.ts';
import { announce } from './activities.ts';
import { followerInboxes } from './followers.ts';
import { enqueueDeliveries } from './queue.ts';
import { withTags, type ActorRef } from './records.ts';

// Storing an activity we sent (so it is served at its id) and queueing it for the inboxes it
// goes to. Runs in a consumer's transaction: the activity row and its delivery rows commit
// with the consumer's cursor, or not at all.

/** A new local activity id, below /ap/activity/ (served from the activities table). */
export const newActivityId = (origin: string): string => newObjectApId(origin, 'activity', randomUUID());

/** The id of what an activity is about, for activities.object_ap_id. */
function objectOf(activity: Activity): string | null {
  switch (activity.type) {
    case 'Create':
    case 'Update':
      return activity.object.type === 'Actor'
        ? activity.object.actor.apId
        : activity.object.type === 'Page'
          ? activity.object.post.apId
          : activity.object.comment.apId;
    case 'Like':
    case 'Dislike':
      return activity.vote.targetApId;
    case 'Follow':
      return activity.follow.followeeApId;
    case 'Announce':
      return 'id' in activity.object
        ? activity.object.id
        : 'post' in activity.object
          ? activity.object.post.apId
          : activity.object.comment.apId;
    case 'Accept':
    case 'Reject':
    case 'Undo':
      return activity.object.id;
    case 'Delete':
    case 'Lock':
    case 'Add':
    case 'Remove':
    case 'Block':
      return activity.objectApId;
    case 'Flag':
      return activity.report.targetApId;
  }
}

export type StoredActivity = { wire: JsonObject; body: string };

/**
 * Serialises `activity` in the Lemmy dialect (the one text every inbox gets), with `tags`
 * (Mention objects) on the post or comment it carries, and stores it in `activities`.
 */
export async function storeActivity(t: OpenTx, activity: Activity, tags: readonly Json[] = []): Promise<StoredActivity> {
  const wire = withTags(toWire({ kind: 'activity', activity }), tags);
  await t.db
    .insert(activities)
    .values({
      apId: activity.id,
      type: activity.type,
      actorApId: activity.actorApId,
      objectApId: objectOf(activity),
      local: true,
      raw: wire,
    })
    .onConflictDoNothing();
  return { wire, body: JSON.stringify(wire) };
}

/** Stores `activity` and queues it, signed by `sender`, for `inboxes`. */
export async function sendActivity(
  t: OpenTx,
  sender: ActorRef,
  activity: Activity,
  inboxes: readonly string[],
  tags: readonly Json[] = [],
): Promise<void> {
  if (inboxes.length === 0) return;
  const { body } = await storeActivity(t, activity, tags);
  await enqueueDeliveries(t, { activityApId: activity.id, senderId: sender.id, body, inboxes });
}

export type CommunityContext = { origin: string; author: ActorRef; community: ActorRef };

/**
 * Publishes an activity a local actor did in a community.
 *
 * - In a remote community the author's activity goes to the community's inbox, and the
 *   community announces it to its followers.
 * - In a local community the activity is stored (it is served at its id and listed in the
 *   outbox) and the community announces it to each remote follower inbox in one shape:
 *   Announce(activity) for threadiverse software and for anything unknown, and, for a new post
 *   only (`page`), Announce(Page) to Mastodon-like software instead. Never both to one inbox.
 */
export async function publishInCommunity(
  t: OpenTx,
  { origin, author, community }: CommunityContext,
  inner: Activity,
  options: { page?: PostRecord; tags?: readonly Json[] } = {},
): Promise<void> {
  const tags = options.tags ?? [];
  if (!community.local) {
    if (community.inboxUrl) await sendActivity(t, author, inner, [community.inboxUrl], tags);
    return;
  }
  await storeActivity(t, inner, tags);
  const targets = await followerInboxes(t.db, community.id);
  const announceTo = async (object: Activity | ContentObject, inboxes: readonly string[]) =>
    sendActivity(
      t,
      community,
      announce({ id: newActivityId(origin), actorApId: community.apId, communityApId: community.apId }, object),
      inboxes,
      tags,
    );
  await announceTo(inner, options.page ? targets.create : [...targets.create, ...targets.page]);
  if (options.page) await announceTo({ type: 'Page', post: options.page }, targets.page);
}
