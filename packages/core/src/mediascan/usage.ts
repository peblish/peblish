import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { posts } from '../db/tables/content.ts';
import { deliveries } from '../delivery/tables.ts';

// Where an uploaded image is used. Posts name media only by its URL (`<origin>/media/<id>`), in
// `url` (an image post) or `thumbnail_url`; there is no index on either, and the lookup is for
// the rare quarantined image, so it scans.

export const mediaUrl = (origin: string, mediaId: Uuid) => `${origin}/media/${mediaId}`;

export type UsingPost = { id: Uuid; apId: string; communityId: Uuid };

/** The posts that show this image and are not yet removed or deleted by anyone. */
export async function livePostsUsing(q: Queryable, mediaId: Uuid): Promise<UsingPost[]> {
  const url = mediaUrl((await localInstance(q)).origin, mediaId);
  return q
    .select({ id: posts.id, apId: posts.apId, communityId: posts.communityId })
    .from(posts)
    .where(and(or(eq(posts.url, url), eq(posts.thumbnailUrl, url)), isNull(posts.removedAt), isNull(posts.deletedAt)));
}

/** Every post that names the image, live or not, for the evidence manifest. */
export async function postsNaming(q: Queryable, mediaId: Uuid) {
  const url = mediaUrl((await localInstance(q)).origin, mediaId);
  return q
    .select({ id: posts.id, apId: posts.apId })
    .from(posts)
    .where(or(eq(posts.url, url), eq(posts.thumbnailUrl, url)));
}

/** Outbound deliveries still queued whose body carries the image's URL. */
export async function pendingDeliveriesNaming(q: Queryable, mediaId: Uuid) {
  const url = mediaUrl((await localInstance(q)).origin, mediaId);
  return q
    .select({ id: deliveries.id, activityApId: deliveries.activityApId, inboxUrl: deliveries.inboxUrl })
    .from(deliveries)
    .where(and(eq(deliveries.state, 'pending'), sql`strpos(${deliveries.body}, ${url}) > 0`))
    .limit(200);
}
