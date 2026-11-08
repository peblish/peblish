import type { ModInput } from '@peblish/schema/modlog';
import { eq } from 'drizzle-orm';
import { contentState } from '../authz/state.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation, type MutationTx } from '../tx/mutation.ts';
import type { Authorized } from '../authz/brand.ts';
import { isLocal, locked, moderationInput, vanished } from './shared.ts';

// Owned by lane AZ (M03). Remove and restore a post or comment with a statement of reasons.
// Restoring clears removed_at; both actions stay in the modlog.

async function setRemoved(
  t: MutationTx<'mod.remove'>,
  grant: Authorized<'mod.remove'> | Authorized<'mod.restore'>,
  input: ModInput,
  removed: boolean,
) {
  const { reason, activityApId, details } = moderationInput(input);
  const { target } = grant.subject;
  const state = await contentState(locked(t.db), target);
  if (!state) throw vanished(`${target.kind} ${target.id}`);
  const removedAt = removed ? new Date() : null;
  if (target.kind === 'post') await t.db.update(posts).set({ removedAt }).where(eq(posts.id, target.id));
  else await t.db.update(comments).set({ removedAt }).where(eq(comments.id, target.id));
  const modlogId = await writeModlog(t.db, grant, {
    community: state.community,
    target: target.kind === 'post' ? { postId: target.id, apId: state.apId } : { commentId: target.id, apId: state.apId },
    reason,
    details,
    activityApId,
  });
  await t.emit({
    type: 'mod.remove',
    v: 1,
    modlogId,
    moderatorId: grant.actorId,
    local: isLocal(grant.principal),
    communityId: state.community.id,
    target: { kind: target.kind, id: target.id },
    targetApId: state.apId,
    removed,
    reason,
  });
  return { modlogId };
}

export const removeContent = defineMutation({
  action: 'mod.remove',
  emits: ['mod.remove'],
  recheck: true,
  run: (t, grant, input: ModInput) => setRemoved(t, grant, input, true),
});

export const restoreContent = defineMutation({
  action: 'mod.restore',
  emits: ['mod.remove'],
  recheck: true,
  run: (t, grant, input: ModInput) => setRemoved(t, grant, input, false),
});
