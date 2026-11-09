import { localInstance } from '@peblish/core/db/local-instance';
import { activities } from '@peblish/core/db/tables/federation';
import type { OpenTx } from '@peblish/core/tx/tx';
import { announce } from '../delivery/activities.ts';
import { followerInboxes } from '../delivery/followers.ts';
import { newActivityId, sendActivity } from '../delivery/send.ts';
import { enqueueDeliveries } from '../delivery/queue.ts';
import { actorRefs } from '../delivery/records.ts';
import { withdrawBoosts } from '../delivery/withdraw.ts';
import type { JsonObject } from '../mapping/json.ts';
import type { PostRecord } from '../mapping/records.ts';
import { followersOf, LEMMY_CONTEXT, PUBLIC } from '../mapping/vocabulary.ts';

// FEP-1b12 for what reaches a local community directly: an activity a remote actor sent to
// the community (a post, a comment, a vote, a remote moderator's action) is applied, then the
// community announces it to its followers, except the server it came from. It runs inside the
// transaction that applied the activity (inbound/pipeline.ts), so the state change, the
// dedupe marker and the deliveries commit together or not at all.
//
// The Announce embeds the activity's JSON exactly as received: Fedify's serialiser and
// announceJson() work on parsed JSON, which collapses one-element arrays and drops terms
// Lemmy's strict parser needs (spike finding), so the received text is spliced into the
// Announce text between its own members instead.

export type Relayed = {
  communityId: string;
  /** The request body as received. */
  body: Uint8Array;
  /** The same, parsed: the fallback when the bytes are not UTF-8 text, and the activity's id. */
  json: JsonObject;
  /** The actor that sent it; its origin already has the activity. */
  senderApId: string;
  /** Set for a new post: Mastodon-like followers get Announce(Page), the only thing they are sent (delivery/software.ts). */
  page?: PostRecord;
};

/** The Announce of `inner` (its JSON text, spliced in as is) by a community, as one JSON text. */
export function announceText(id: string, communityApId: string, inner: string): string {
  const head = JSON.stringify({
    '@context': LEMMY_CONTEXT,
    id,
    type: 'Announce',
    actor: communityApId,
    to: [PUBLIC],
    cc: [followersOf(communityApId)],
  });
  return `${head.slice(0, -1)},"object":${inner}}`;
}

/**
 * The text of `body` when decoding and encoding it again gives the same bytes; otherwise the
 * parsed activity, serialised. Receipt refuses a body that does not round trip (inbound/receive.ts),
 * so the fallback is only for rows stored before it did.
 */
function exactText(body: Uint8Array, fallback: JsonObject): string {
  const text = new TextDecoder().decode(body);
  return Buffer.from(text, 'utf8').equals(Buffer.from(body)) ? text : JSON.stringify(fallback);
}

/**
 * Queues the community's Announce of `relayed` for every threadiverse follower inbox but the
 * sender's, and for Mastodon-like ones only what they can apply (the new post, the withdrawal of
 * a deleted one). Does nothing for a community that is not local (it announces to its own followers).
 */
export async function relayToFollowers(t: OpenTx, relayed: Relayed): Promise<void> {
  const community = (await actorRefs(t.db, [relayed.communityId])).get(relayed.communityId);
  if (!community?.local || community.deleted) return;
  const { origin } = await localInstance(t.db);
  const targets = await followerInboxes(t.db, community.id, { skipOrigin: new URL(relayed.senderApId).origin });
  const innerId = typeof relayed.json.id === 'string' ? relayed.json.id : null;
  // Mastodon-like inboxes are sent a new post only, and the withdrawal of a post when it is deleted.
  const threadiverse = targets.create;
  if (threadiverse.length > 0) {
    const id = newActivityId(origin);
    const text = announceText(id, community.apId, exactText(relayed.body, relayed.json));
    await t.db
      .insert(activities)
      .values({ apId: id, type: 'Announce', actorApId: community.apId, objectApId: innerId, local: true, raw: JSON.parse(text) })
      .onConflictDoNothing();
    await enqueueDeliveries(t, { activityApId: id, senderId: community.id, body: text, inboxes: threadiverse });
  }
  if (relayed.page && targets.page.length > 0) {
    const base = { id: newActivityId(origin), actorApId: community.apId, communityApId: community.apId };
    await sendActivity(t, community, announce(base, { type: 'Page', post: relayed.page }), targets.page);
  }
  // A Delete of a post takes its boosts back. Of a comment or an actor it finds none.
  if (relayed.json.type === 'Delete') {
    const object = relayed.json.object;
    const deleted =
      typeof object === 'string' ? object : typeof object === 'object' && object !== null && 'id' in object ? object.id : null;
    if (typeof deleted === 'string') await withdrawBoosts(t, { origin, community, postApId: deleted });
  }
}
