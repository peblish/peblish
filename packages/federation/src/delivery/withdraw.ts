import type { Queryable } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { activities } from '@peblish/core/db/tables/federation';
import { deliveries } from '@peblish/core/delivery/tables';
import type { OpenTx } from '@peblish/core/tx/tx';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { JsonObject } from '../mapping/json.ts';
import type { Activity } from '../mapping/records.ts';
import { followersOf, LEMMY_CONTEXT, PUBLIC } from '../mapping/vocabulary.ts';
import { remove } from './activities.ts';
import { followerInboxes } from './followers.ts';
import { newActivityId, sendActivity } from './send.ts';
import { enqueueDeliveries } from './queue.ts';
import { actorRefs, type ActorRef } from './records.ts';

// Taking a post back from Mastodon-like followers. Mastodon ignores a group's Announce(Delete)
// as it ignores Announce(Create(Page)), so the boost of a post it was sent as Announce(Page)
// stays until the community undoes that very Announce, and the original status stays until its
// author deletes it (Mastodon looks a Delete up by the author, an Undo(Announce) by the booster).

export type Boost = { announceApId: string; inboxes: string[] };

/**
 * The community's Announce(Page) of `postApId` that no Undo has taken back yet, with the inboxes
 * its deliveries went to. Delivery rows are pruned 30 days after settling, so `inboxes` can be
 * empty for an old boost; the activity row stays.
 */
export async function boostsOf(db: Queryable, communityApId: string, postApId: string): Promise<Boost[]> {
  const announced = await db
    .select({ apId: activities.apId })
    .from(activities)
    .where(
      and(
        eq(activities.type, 'Announce'),
        eq(activities.local, true),
        eq(activities.actorApId, communityApId),
        eq(activities.objectApId, postApId),
      ),
    );
  if (announced.length === 0) return [];
  const undone = new Set(
    (
      await db
        .select({ announceApId: activities.objectApId })
        .from(activities)
        .where(
          and(
            eq(activities.type, 'Undo'),
            eq(activities.local, true),
            inArray(
              activities.objectApId,
              announced.map(({ apId }) => apId),
            ),
          ),
        )
    ).map(({ announceApId }) => announceApId),
  );
  const open = announced.map(({ apId }) => apId).filter((apId) => !undone.has(apId));
  if (open.length === 0) return [];
  const sent = await db
    .select({ announceApId: deliveries.activityApId, inbox: deliveries.inboxUrl })
    .from(deliveries)
    .where(inArray(deliveries.activityApId, open));
  return open.map((announceApId) => ({
    announceApId,
    inboxes: sent.filter((row) => row.announceApId === announceApId).map((row) => row.inbox),
  }));
}

/**
 * The community's Undo of an Announce(Page) it sent, as Mastodon's `undo.rb` reads it: the
 * Announce is embedded with its own id and actor, the object a bare IRI. Raw JSON, like
 * `announceText`: the mapping has no Undo of an Announce.
 */
export function undoAnnounce(id: string, communityApId: string, announceApId: string, postApId: string): JsonObject {
  const addressing = { to: [PUBLIC], cc: [followersOf(communityApId)] };
  return {
    '@context': LEMMY_CONTEXT,
    id,
    type: 'Undo',
    actor: communityApId,
    ...addressing,
    object: { id: announceApId, type: 'Announce', actor: communityApId, ...addressing, object: postApId },
  };
}

/**
 * Queues the Undo of each boost of `postApId` in a local community, to the inboxes it went to
 * and to the Mastodon-like followers now (an instance that unfollowed since still gets it), and,
 * when a local person wrote the post, that person's Delete to the same inboxes. A post never
 * boosted, or whose boosts were all undone, queues nothing: a second removal event is a no-op.
 *
 * `announced` is the activity already announced to threadiverse followers for this withdrawal.
 * When it is the author's own Delete without a summary, it is reused as the Delete (one id for
 * everyone); a moderator's Delete carries a reason and is not.
 */
export async function withdrawBoosts(
  t: OpenTx,
  { origin, community, postApId, announced }: { origin: string; community: ActorRef; postApId: string; announced?: Activity },
): Promise<void> {
  const boosts = await boostsOf(t.db, community.apId, postApId);
  if (boosts.length === 0) return;
  const current = (await followerInboxes(t.db, community.id)).page;
  const everywhere = new Set(current);
  for (const boost of boosts) {
    const id = newActivityId(origin);
    const wire = undoAnnounce(id, community.apId, boost.announceApId, postApId);
    await t.db
      .insert(activities)
      .values({ apId: id, type: 'Undo', actorApId: community.apId, objectApId: boost.announceApId, local: true, raw: wire })
      .onConflictDoNothing();
    const inboxes = [...new Set([...boost.inboxes, ...current])];
    for (const inbox of inboxes) everywhere.add(inbox);
    await enqueueDeliveries(t, { activityApId: id, senderId: community.id, body: JSON.stringify(wire), inboxes });
  }
  const [post] = await t.db.select({ authorId: posts.authorId }).from(posts).where(eq(posts.apId, postApId));
  const author = post ? (await actorRefs(t.db, [post.authorId])).get(post.authorId) : undefined;
  if (!author?.local) return;
  const reuse = announced?.type === 'Delete' && announced.actorApId === author.apId && announced.reason === null;
  const base = { id: reuse ? announced.id : newActivityId(origin), actorApId: author.apId, communityApId: community.apId };
  await sendActivity(t, author, remove(base, postApId), [...everywhere].sort());
}

/** How many of a banned member's removed posts one ban event withdraws; the rest stay boosted until removed one by one. */
export const BULK_WITHDRAWAL_CAP = 200;

export type BoostedPost = { apId: string; communityId: string };

/**
 * The posts `authorId` has removed that still have a boost to take back, newest removal first,
 * at most `limit` (a ban with removeContent removes them without one event each), in
 * `communityId` or, without it, in every local community.
 */
export async function removedBoostedPosts(
  db: Queryable,
  authorId: string,
  { communityId, limit = BULK_WITHDRAWAL_CAP }: { communityId?: string; limit?: number } = {},
): Promise<BoostedPost[]> {
  return db
    .select({ apId: posts.apId, communityId: posts.communityId })
    .from(posts)
    .where(
      and(
        communityId ? eq(posts.communityId, communityId) : undefined,
        eq(posts.authorId, authorId),
        isNotNull(posts.removedAt),
        sql`exists (
          select 1 from activities a join actors c on c.ap_id = a.actor_ap_id and c.id = ${posts.communityId}
          where a.type = 'Announce' and a.local and a.object_ap_id = ${posts.apId}
            and not exists (select 1 from activities u where u.type = 'Undo' and u.local and u.object_ap_id = a.ap_id)
        )`,
      ),
    )
    .orderBy(desc(posts.removedAt))
    .limit(limit);
}
