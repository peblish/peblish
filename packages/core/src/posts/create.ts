import { newObjectApId } from '@peblish/schema/actor-urls';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane B1 after G0: the reference mutation every write service follows. Markdown
// rendering (lane MD) fills contentHtml later; until then local posts carry the source only.
export const createPost = defineMutation({
  action: 'post.create',
  emits: ['post.created'],
  async run(t, grant, input: { title: string; url?: string | null; bodyMd?: string | null; sensitive?: boolean }) {
    const instance = await localInstance(t.db);
    const id = uuidv7();
    const { communityId } = grant.subject;
    await t.db.insert(posts).values({
      id,
      apId: newObjectApId(instance.origin, 'post', id),
      local: true,
      instanceId: instance.id,
      authorId: grant.actorId,
      communityId,
      title: input.title,
      url: input.url ?? null,
      bodyMd: input.bodyMd ?? null,
      sensitive: input.sensitive ?? false,
      publishedAt: new Date(),
    });
    await t.emit({ type: 'post.created', v: 1, postId: id, communityId, authorId: grant.actorId, local: true });
    return { id };
  },
});
