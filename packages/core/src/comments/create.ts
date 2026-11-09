import { newObjectApId } from '@peblish/schema/actor-urls';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { renderLocalBody } from '../posts/body.ts';
import { defineMutation } from '../tx/mutation.ts';
import { insertComment } from './insert.ts';
import { NewComment } from './input.ts';

/**
 * A local person's comment on a post or a reply to one. The policy (authz/actions/comments.ts)
 * lets a person with a verified email take part in an open community that has not banned them,
 * on a post that is not locked, deleted or removed, under a comment that is neither, and
 * refuses a reply to level 50; it rechecks inside the transaction because a ban, a lock or a
 * removal can land after authorize().
 *
 * The input is validated here as well as at the caller's boundary. content_html is rendered
 * here, once, against the instance's own origin: it is what federates (lane FED-A); pages
 * render bodyMd themselves. The post's comment_count and the parent's child_count change in
 * the same transaction (insertComment).
 */
export const createComment = defineMutation({
  action: 'comment.create',
  emits: ['comment.created'],
  recheck: true,
  async run(t, grant, raw: NewComment) {
    const input = NewComment.assert(raw);
    const { postId, parentId } = grant.subject;
    const instance = await localInstance(t.db);
    const id = uuidv7();
    const apId = newObjectApId(instance.origin, 'comment', id);
    await insertComment(
      t.db,
      { postId, parentId },
      {
        id,
        apId,
        local: true,
        instanceId: instance.id,
        authorId: grant.actorId,
        bodyMd: input.bodyMd,
        contentHtml: renderLocalBody(input.bodyMd, instance.origin, id),
        language: input.language ?? null,
        publishedAt: new Date(),
      },
    );
    await t.emit({ type: 'comment.created', v: 1, commentId: id, postId, authorId: grant.actorId, local: true, parentId });
    return { id, apId };
  },
});
