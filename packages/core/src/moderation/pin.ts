import type { ModInput } from '@peblish/schema/modlog';
import { eq } from 'drizzle-orm';
import type { Authorized } from '../authz/brand.ts';
import { postState } from '../authz/state.ts';
import { posts } from '../db/tables/content.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation, type MutationTx } from '../tx/mutation.ts';
import { isLocal, locked, moderationInput, vanished } from './shared.ts';

// Owned by lane AZ. Pins a post in its community (featured_community); the site's front-page
// feature (featured_local, scope 'local') is an admin action of its own.

async function setPinned(
  t: MutationTx<'mod.feature'>,
  grant: Authorized<'mod.pin'> | Authorized<'mod.unpin'>,
  input: ModInput,
  pinned: boolean,
) {
  const { reason, activityApId, details } = moderationInput(input);
  const { postId } = grant.subject;
  const post = await postState(locked(t.db), postId);
  if (!post) throw vanished(`post ${postId}`);
  await t.db.update(posts).set({ featuredCommunity: pinned }).where(eq(posts.id, postId));
  const modlogId = await writeModlog(t.db, grant, {
    community: post.community,
    target: { postId, apId: post.apId },
    reason,
    details,
    activityApId,
  });
  await t.emit({
    type: 'mod.feature',
    v: 1,
    modlogId,
    moderatorId: grant.actorId,
    local: isLocal(grant.principal),
    communityId: post.community.id,
    postId,
    targetApId: post.apId,
    scope: 'community',
    featured: pinned,
  });
  return { modlogId };
}

export const pinPost = defineMutation({
  action: 'mod.pin',
  emits: ['mod.feature'],
  recheck: true,
  run: (t, grant, input: ModInput) => setPinned(t, grant, input, true),
});

export const unpinPost = defineMutation({
  action: 'mod.unpin',
  emits: ['mod.feature'],
  recheck: true,
  run: (t, grant, input: ModInput) => setPinned(t, grant, input, false),
});
