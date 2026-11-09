import { BanInput, type ModInput } from '@peblish/schema/modlog';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
import { writeModlog } from '../modlog/write.ts';
import { isLocal, moderationInput, vanished } from '../moderation/shared.ts';
import { defineMutation } from '../tx/mutation.ts';
import { siteBans } from './tables.ts';

// Lane MODF (M06). Ban a person from the whole instance, and lift it. A ban is an INSERT, which
// no lock on a missing row can serialise, so the mutation takes FOR NO KEY UPDATE on the target
// actor row before inserting: the principal refresh (authz/principal.ts) holds that row FOR
// SHARE in every write the target makes, so the ban waits for those writes to commit and any
// later one finds the ban. The lock order ends there: no community row is locked afterwards.
// Federation sends (outbound) and reads (inbound, source 'remote') the Block of a whole instance.

export const banFromSite = defineMutation({
  action: 'mod.site_ban',
  emits: ['mod.ban'],
  recheck: true,
  async run(t, grant, input: BanInput) {
    const valid = BanInput.assert(input);
    const { reason, activityApId, details } = moderationInput(valid);
    const expiresAt = valid.expiresAt ? new Date(valid.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new RangeError('a ban must expire in the future');
    const removeContent = valid.removeContent ?? false;
    const { targetActorId } = grant.subject;
    const [target] = await t.db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, targetActorId)).for('no key update');
    if (!target) throw vanished(`site ban of ${targetActorId}`);
    const ban = {
      source: grant.principal.kind === 'remote' ? ('remote' as const) : ('local' as const),
      reason,
      expiresAt,
      bannedBy: grant.actorId,
      activityApId,
      removeContent,
    };
    // An expired ban row may still be there; the new ban replaces it.
    await t.db
      .insert(siteBans)
      .values({ actorId: targetActorId, ...ban })
      .onConflictDoUpdate({ target: siteBans.actorId, set: { ...ban, createdAt: sql`now()` } });
    const removed = removeContent ? await removeAuthorContent(t.db, targetActorId) : { posts: 0, comments: 0 };
    const modlogId = await writeModlog(t.db, grant, {
      community: null,
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
      communityId: null,
      banned: true,
      removeContent,
      expiresAt: valid.expiresAt ?? null,
      reason,
    });
    return { modlogId, removed };
  },
});

/**
 * Removes the actor's live posts, then their live comments, in every community (the same
 * restorable removal a community ban with removal makes, post by post: lock order in
 * authz/state.ts, and no community row is touched).
 */
async function removeAuthorContent(db: WriteTx, actorId: string) {
  const now = new Date();
  const removedPosts = await db
    .update(posts)
    .set({ removedAt: now })
    .where(and(eq(posts.authorId, actorId), isNull(posts.removedAt), isNull(posts.deletedAt)))
    .returning({ id: posts.id });
  const removedComments = await db
    .update(comments)
    .set({ removedAt: now })
    .where(and(eq(comments.authorId, actorId), isNull(comments.removedAt), isNull(comments.deletedAt)))
    .returning({ id: comments.id });
  return { posts: removedPosts.length, comments: removedComments.length };
}

export const unbanFromSite = defineMutation({
  action: 'mod.site_unban',
  emits: ['mod.ban'],
  recheck: true,
  async run(t, grant, input: ModInput) {
    const { reason, activityApId, details } = moderationInput(input);
    const { targetActorId } = grant.subject;
    const [target] = await t.db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, targetActorId)).for('no key update');
    if (!target) throw vanished(`site unban of ${targetActorId}`);
    await t.db.delete(siteBans).where(eq(siteBans.actorId, targetActorId));
    const modlogId = await writeModlog(t.db, grant, {
      community: null,
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
      communityId: null,
      banned: false,
      removeContent: false,
      expiresAt: null,
      reason,
    });
    return { modlogId };
  },
});
