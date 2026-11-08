import type { Authority } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { ModlogDetails } from '@peblish/schema/modlog';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { actors } from '../db/tables/actors.ts';
import { modlog } from '../db/tables/moderation.ts';
import type { WriteTx } from '../db/write.ts';
import type { ActionName } from '../authz/policy.ts';
import type { Frozen } from '../authz/frozen.ts';

/** What a modlog row names besides its actor: each reference with its ap_id, so purges keep the log readable. */
export type ModlogEntryInput = {
  community: { id: Uuid; apId: string } | null;
  target: { actorId?: Uuid; postId?: Uuid; commentId?: Uuid; apId: string } | null;
  reason: string | null;
  details?: ModlogDetails;
  activityApId?: string | null;
};

/**
 * Appends the modlog row for a moderation mutation, inside its transaction (pass t.db): the
 * action, actor and authority come from the grant, so the log records exactly what was
 * authorized. Every mod.* mutation calls it once and puts the returned id in its event.
 */
export async function writeModlog(
  db: WriteTx,
  grant: { action: ActionName; actorId: Uuid; authority: Frozen<Authority> },
  entry: ModlogEntryInput,
): Promise<Uuid> {
  const [actor] = await db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, grant.actorId));
  if (!actor) throw new Error(`modlog: no actor ${grant.actorId}`);
  const id = uuidv7();
  await db.insert(modlog).values({
    id,
    action: grant.action,
    actorId: grant.actorId,
    actorApId: actor.apId,
    communityId: entry.community?.id ?? null,
    communityApId: entry.community?.apId ?? null,
    targetActorId: entry.target?.actorId ?? null,
    targetPostId: entry.target?.postId ?? null,
    targetCommentId: entry.target?.commentId ?? null,
    targetApId: entry.target?.apId ?? null,
    reason: entry.reason,
    authority: grant.authority,
    details: ModlogDetails.assert(entry.details ?? {}),
    activityApId: entry.activityApId ?? null,
  });
  return id;
}
