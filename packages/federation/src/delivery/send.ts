import { randomUUID } from 'node:crypto';
import { activities } from '@peblish/core/db/tables/federation';
import type { OpenTx } from '@peblish/core/tx/tx';
import { newObjectApId } from '@peblish/schema/actor-urls';
import { toWire } from '../mapping/document.ts';
import type { Json, JsonObject } from '../mapping/json.ts';
import type { Activity } from '../mapping/records.ts';
import { enqueueDeliveries } from './queue.ts';
import { withCc, withTags, type ActorRef } from './records.ts';

// Storing an activity we sent (so it is served at its id) and queueing it for the inboxes it
// goes to. Runs in a consumer's transaction: the activity row and its delivery rows commit
// with the consumer's cursor, or not at all. publish.ts re-exports these for the lanes that
// import them from there.

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
 * (Mention objects) on the post or comment it carries and `cc` (the people it mentions) added
 * to its addressing, and stores it in `activities`.
 */
export async function storeActivity(
  t: OpenTx,
  activity: Activity,
  tags: readonly Json[] = [],
  cc: readonly string[] = [],
): Promise<StoredActivity> {
  const wire = withCc(withTags(toWire({ kind: 'activity', activity }), tags), cc);
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
  cc: readonly string[] = [],
): Promise<void> {
  if (inboxes.length === 0) return;
  const { body } = await storeActivity(t, activity, tags, cc);
  await enqueueDeliveries(t, { activityApId: activity.id, senderId: sender.id, body, inboxes });
}
