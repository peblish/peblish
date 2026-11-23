import { asc, count, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '../db/read.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { notifications } from '../notifications/tables.ts';
import type { NotificationKind } from '../notifications/view.ts';
import { communityPins } from '../pins/tables.ts';
import { savedPosts } from '../saves/tables.ts';
import { threadVisits } from '../visits/tables.ts';
import { threadWatches } from '../watches/tables.ts';
import { seedPost } from './seed-az.ts';
import { seedActor } from './seed.ts';

// Lane B06's seeds for the personal features (saves, pins, thread follows, visit markers): rows
// written straight into their tables, for tests of deletion, replay and owner-only reads. Test
// code only; the feature lanes' own mutations are what product code writes through.

/** A local community and a post in it by `authorId`, on the local instance a seedLocalInstance already made. */
export async function seedPersonalTargets(authorId: string, name = 'pinned') {
  const [instance] = await db().select().from(instances).where(eq(instances.local, true));
  if (!instance) throw new Error('seed the local instance first');
  const community = await seedActor(instance, 'Group', name);
  const post = await seedPost(instance, community, { id: authorId });
  return { community, post };
}

/** One row in each personal table for `ownerId`: a save of `postId`, a pin of `communityId`, a follow of and a visit to the thread. */
export async function seedPersonalRows(ownerId: string, { postId, communityId }: { postId: string; communityId: string }) {
  const w = writer();
  await w.insert(savedPosts).values({ ownerId, postId });
  await w.insert(communityPins).values({ ownerId, communityId, position: 0 });
  await w.insert(threadWatches).values({ ownerId, postId });
  await w.insert(threadVisits).values({ ownerId, postId, lastVisitAt: new Date() });
}

/**
 * The four personal tables by name, written out here rather than read from personalTables, so a
 * deletion test per table survives that list losing one, and fails.
 */
const byName = { saved_posts: savedPosts, community_pins: communityPins, thread_watches: threadWatches, thread_visits: threadVisits };
export type PersonalTableName = keyof typeof byName;

/** How many rows one personal table holds for `ownerId`. */
export async function personalRowCount(name: PersonalTableName, ownerId: string): Promise<number> {
  const table = byName[name];
  const [row] = await db().select({ n: count() }).from(table).where(eq(table.ownerId, ownerId));
  return row?.n ?? 0;
}

/** Notices for the deletion tests: one in `recipientId`'s inbox naming `actorId` per kind given. */
export async function seedPersonalNotices(recipientId: string, actorId: string | null, kinds: readonly NotificationKind[]) {
  for (const kind of kinds) await writer().insert(notifications).values({ recipientId, kind, refId: uuidv7(), actorId });
}

/** The kinds in a person's inbox with who each names, oldest first. */
export async function noticesNaming(recipientId: string): Promise<{ kind: string; actorId: string | null }[]> {
  return db()
    .select({ kind: notifications.kind, actorId: notifications.actorId })
    .from(notifications)
    .where(eq(notifications.recipientId, recipientId))
    .orderBy(asc(notifications.id));
}
