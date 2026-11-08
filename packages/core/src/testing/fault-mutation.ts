import { posts } from '../db/tables/content.ts';
import { localInstance } from '../db/local-instance.ts';
import { defineMutation } from '../tx/mutation.ts';

/** createPost's shape with a hook between apply (insert) and enqueue (emit) for fault injection. */
export function postWithFault(fault: () => Promise<void>) {
  return defineMutation({
    action: 'post.create',
    emits: ['post.created'],
    async run(t, grant, input: { id: string }) {
      const instance = await localInstance(t.db);
      await t.db.insert(posts).values({
        id: input.id,
        apId: `${instance.origin}/ap/post/${input.id}`,
        local: true,
        instanceId: instance.id,
        authorId: grant.actorId,
        communityId: grant.subject.communityId,
        title: 'Fault injection',
        publishedAt: new Date(),
      });
      await fault();
      await t.emit({ type: 'post.created', v: 1, postId: input.id, communityId: grant.subject.communityId, authorId: grant.actorId, local: true });
    },
  });
}
