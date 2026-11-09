import { newObjectApId } from '@peblish/schema/actor-urls';
import { type } from 'arktype';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

/**
 * value 1 is an upvote, -1 a downvote and 0 takes the voter's vote back. `apId` and `raw` are
 * for a remote voter only: the Like or Dislike activity's id and body. A local vote's id is
 * minted here, so a local caller cannot choose it.
 */
export const VoteInput = type({ value: '-1 | 0 | 1', 'apId?': 'string.url', 'raw?': 'unknown' });
export type VoteInput = typeof VoteInput.infer;

/**
 * One row per voter and target. A change of direction deletes the row and inserts a new one
 * with a new Like or Dislike id (the id is immutable and federates), and value 0 deletes. The
 * target's upvotes and downvotes change in the same transaction, on the row the recheck
 * already holds (the community, then the post, then the comment). Casting what is already
 * cast changes nothing and emits nothing.
 *
 * The voter is the grant's actor. A remote Undo(Like) carries a freshly minted Like id, so it
 * is applied as value 0 with no apId: the vote is found by voter and target, never by id.
 * vote.cast carries the new activity's id and the replaced vote's id (null when there was
 * none), the only place the replaced id survives, for the outbound Undo.
 */
export const castVote = defineMutation({
  action: 'vote.cast',
  emits: ['vote.cast'],
  // A ban or a deleted target can land after authorize(); AZ's note: votes in one community
  // then take turns on the community row, which is fine at beta scale.
  recheck: true,
  async run(t, grant, raw: VoteInput) {
    const input = VoteInput.assert(raw);
    const remote = grant.principal.kind === 'remote';
    if (remote && input.value !== 0 && !input.apId) throw new TypeError('a remote vote needs the activity id (apId)');
    if (!remote && (input.apId !== undefined || input.raw !== undefined)) throw new TypeError('a local vote mints its own id');
    const { target } = grant.subject;
    const [existing] = await t.db
      .select({ id: votes.id, apId: votes.apId, value: votes.value })
      .from(votes)
      .where(and(eq(votes.voterId, grant.actorId), eq(target.kind === 'post' ? votes.postId : votes.commentId, target.id)));
    const previous = existing ? (existing.value === 1 ? 1 : -1) : 0;
    if (previous === input.value) return { changed: false, value: input.value };
    if (existing) await t.db.delete(votes).where(eq(votes.id, existing.id));
    let apId: string | null = null;
    if (input.value !== 0) {
      const instance = await localInstance(t.db);
      const [voter] = remote ? await t.db.select({ instanceId: actors.instanceId }).from(actors).where(eq(actors.id, grant.actorId)) : [];
      if (remote && !voter) throw new Refused('vote.cast', 'auth.required');
      const id = uuidv7();
      apId = input.apId ?? newObjectApId(instance.origin, 'activity', id);
      await t.db.insert(votes).values({
        id,
        apId,
        local: !remote,
        instanceId: voter?.instanceId ?? instance.id,
        raw: input.raw,
        voterId: grant.actorId,
        postId: target.kind === 'post' ? target.id : null,
        commentId: target.kind === 'comment' ? target.id : null,
        value: input.value,
      });
    }
    const up = Number(input.value === 1) - Number(previous === 1);
    const down = Number(input.value === -1) - Number(previous === -1);
    if (target.kind === 'post') {
      await t.db
        .update(posts)
        .set({ upvotes: sql`${posts.upvotes} + ${up}`, downvotes: sql`${posts.downvotes} + ${down}` })
        .where(eq(posts.id, target.id));
    } else {
      await t.db
        .update(comments)
        .set({ upvotes: sql`${comments.upvotes} + ${up}`, downvotes: sql`${comments.downvotes} + ${down}` })
        .where(eq(comments.id, target.id));
    }
    await t.emit({
      type: 'vote.cast',
      v: 1,
      voterId: grant.actorId,
      target: { kind: target.kind, id: target.id },
      value: input.value,
      previous,
      apId,
      previousApId: existing?.apId ?? null,
      local: !remote,
    });
    return { changed: true, value: input.value };
  },
});
