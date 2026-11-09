import { eq } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { comments } from '../db/tables/content.ts';
import { renderLocalBody } from '../posts/body.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { CommentEdit } from './input.ts';

/**
 * The author's edit of their own comment. The body is replaced and rendered again; the language
 * is kept unless the edit gives one. An edit that changes nothing writes nothing and emits
 * nothing, so "edited" only ever means an edit.
 */
export const updateComment = defineMutation({
  action: 'comment.update',
  emits: ['comment.updated'],
  recheck: true,
  async run(t, grant, raw: CommentEdit) {
    const input = CommentEdit.assert(raw);
    const { commentId } = grant.subject;
    const [comment] = await t.db.select().from(comments).where(eq(comments.id, commentId));
    if (!comment) throw new Refused('comment.update', 'target.not_found');
    const language = input.language === undefined ? comment.language : input.language;
    if (input.bodyMd === comment.bodyMd && language === comment.language) return { changed: false };
    const { origin } = await localInstance(t.db);
    await t.db
      .update(comments)
      .set({ bodyMd: input.bodyMd, contentHtml: renderLocalBody(input.bodyMd, origin, commentId), language, editedAt: new Date() })
      .where(eq(comments.id, commentId));
    await t.emit({
      type: 'comment.updated',
      v: 1,
      commentId,
      postId: comment.postId,
      authorId: comment.authorId,
      local: comment.local,
    });
    return { changed: true };
  },
});
