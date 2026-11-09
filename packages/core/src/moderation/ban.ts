import { BanInput, type ModInput } from '@peblish/schema/modlog';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { communityState } from '../authz/state.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { isLocal, locked, moderationInput, vanished } from './shared.ts';
import { communityBans } from './tables.ts';

// Owned by lane AZ. Community ban and unban. A ban is an INSERT, which no lock on a missing row
// can serialise, so the mutation takes FOR NO KEY UPDATE on the community's actor row first
// (communityState with lock), the row every policy the ban revokes locks before reading bans
// (state.ts). The recheck has already taken that lock; taking it here again keeps the rule
// local to the write. Federation (Block with endTime and removeData, Undo) is lane FED-B's.

export const banFromCommunity = defineMutation({
  action: 'mod.ban',
  emits: ['mod.ban'],
  recheck: true,
  async run(t, grant, input: BanInput) {
    const valid = BanInput.assert(input);
    const { reason, activityApId, details } = moderationInput(valid);
    const expiresAt = valid.expiresAt ? new Date(valid.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new RangeError('a ban must expire in the future');
    const removeContent = valid.removeContent ?? false;
    const { communityId, targetActorId } = grant.subject;
    const community = await communityState(locked(t.db), communityId);
    const [target] = await t.db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, targetActorId));
    if (!community || !target) throw vanished(`ban of ${targetActorId} in ${communityId}`);
    const ban = { reason, expiresAt, bannedBy: grant.actorId };
    // An expired ban row may still be there; the new ban replaces it.
    await t.db
      .insert(communityBans)
      .values({ communityId, actorId: targetActorId, ...ban })
      .onConflictDoUpdate({ target: [communityBans.communityId, communityBans.actorId], set: { ...ban, createdAt: sql`now()` } });
    let removed = { posts: 0, comments: 0 };
    if (removeContent) removed = await removeMemberContent(t.db, communityId, targetActorId);
    const modlogId = await writeModlog(t.db, grant, {
      community,
      target: { actorId: targetActorId, apId: target.apId },
      reason,
      details: {
        ...details,
        expiresAt: valid.expiresAt ?? null,
        removeContent,
        ...(removeContent && { removedPosts: removed.posts, removedComments: removed.comments }),
      },
      activityApId,
    });
    await t.emit({
      type: 'mod.ban',
      v: 1,
      modlogId,
      moderatorId: grant.actorId,
      local: isLocal(grant.principal),
      targetActorId,
      targetApId: target.apId,
      communityId,
      banned: true,
      removeContent,
      expiresAt: valid.expiresAt ?? null,
      reason,
    });
    return { modlogId, removed };
  },
});

/**
 * Removes the actor's live posts in the community and their live comments there, posts first
 * (lock order in state.ts). Each stays restorable one by one; the ban's modlog row counts them
 * and its event's removeContent tells peers to do the same.
 */
async function removeMemberContent(db: WriteTx, communityId: string, actorId: string) {
  const now = new Date();
  const removedPosts = await db
    .update(posts)
    .set({ removedAt: now })
    .where(and(eq(posts.communityId, communityId), eq(posts.authorId, actorId), isNull(posts.removedAt), isNull(posts.deletedAt)))
    .returning({ id: posts.id });
  const inCommunity = db.select({ id: posts.id }).from(posts).where(eq(posts.communityId, communityId));
  const removedComments = await db
    .update(comments)
    .set({ removedAt: now })
    .where(
      and(eq(comments.authorId, actorId), inArray(comments.postId, inCommunity), isNull(comments.removedAt), isNull(comments.deletedAt)),
    )
    .returning({ id: comments.id });
  return { posts: removedPosts.length, comments: removedComments.length };
}

export const unbanFromCommunity = defineMutation({
  action: 'mod.unban',
  emits: ['mod.ban'],
  recheck: true,
  async run(t, grant, input: ModInput) {
    const { reason, activityApId, details } = moderationInput(input);
    const { communityId, targetActorId } = grant.subject;
    const community = await communityState(locked(t.db), communityId);
    const [target] = await t.db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, targetActorId));
    if (!community || !target) throw vanished(`unban of ${targetActorId} in ${communityId}`);
    await t.db.delete(communityBans).where(and(eq(communityBans.communityId, communityId), eq(communityBans.actorId, targetActorId)));
    const modlogId = await writeModlog(t.db, grant, {
      community,
      target: { actorId: targetActorId, apId: target.apId },
      reason,
      details,
      activityApId,
    });
    await t.emit({
      type: 'mod.ban',
      v: 1,
      modlogId,
      moderatorId: grant.actorId,
      local: isLocal(grant.principal),
      targetActorId,
      targetApId: target.apId,
      communityId,
      banned: false,
      removeContent: false,
      expiresAt: null,
      reason,
    });
    return { modlogId };
  },
});
