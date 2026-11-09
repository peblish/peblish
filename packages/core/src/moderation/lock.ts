import type { ModInput } from '@peblish/schema/modlog';
import { eq } from 'drizzle-orm';
import type { Authorized } from '../authz/brand.ts';
import { postState } from '../authz/state.ts';
import { posts } from '../db/tables/content.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation, type MutationTx } from '../tx/mutation.ts';
import { isLocal, locked, moderationInput, vanished } from './shared.ts';

// Owned by lane AZ. A locked post takes no new comments (state.ts: commentingDenial).

async function setLocked(
  t: MutationTx<'mod.lock'>,
  grant: Authorized<'mod.lock'> | Authorized<'mod.unlock'>,
  input: ModInput,
  lock: boolean,
) {
  const { reason, activityApId, details } = moderationInput(input);
  const { postId } = grant.subject;
  const post = await postState(locked(t.db), postId);
  if (!post) throw vanished(`post ${postId}`);
  await t.db.update(posts).set({ locked: lock }).where(eq(posts.id, postId));
  const modlogId = await writeModlog(t.db, grant, {
    community: post.community,
    target: { postId, apId: post.apId },
    reason,
    details,
    activityApId,
  });
  await t.emit({
    type: 'mod.lock',
    v: 1,
    modlogId,
    moderatorId: grant.actorId,
    local: isLocal(grant.principal),
    communityId: post.community.id,
    postId,
    targetApId: post.apId,
    locked: lock,
    reason,
  });
  return { modlogId };
}

export const lockPost = defineMutation({
  action: 'mod.lock',
  emits: ['mod.lock'],
  recheck: true,
  run: (t, grant, input: ModInput) => setLocked(t, grant, input, true),
});

export const unlockPost = defineMutation({
  action: 'mod.unlock',
  emits: ['mod.lock'],
  recheck: true,
  run: (t, grant, input: ModInput) => setLocked(t, grant, input, false),
});
