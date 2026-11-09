import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db as readDb, type Queryable } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { sameMentions } from '../mentions/scan.ts';
import { remoteBody } from '../posts/body.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { insertComment } from './insert.ts';

// A peer's comment, stored by lane FED-B's inbound handler. The caller has verified the
// activity (signature, origins, the claimed community; mapping/README.md, "What the caller
// checks"), resolves what the Note replies to with resolveReplyTarget, and authorizes as the
// remote author: comment.create with { postId, parentId } for a Create, comment.update with
// { commentId } for an Update. The author is the grant's actor, never a field. A peer's Delete
// by the author is deleteComment after comment.delete; a Delete by anyone else is a removal
// (AZ's removeContent).

/** The fields of a mapped CommentRecord (@peblish/federation/mapping/records) that a store reads. */
export type RemoteComment = {
  apId: string;
  /** The post or comment replied to; it must be the one the grant's subject names. */
  inReplyToApId: string;
  /** The Markdown `source`, when the peer sent one. */
  bodyMd: string | null;
  /** The peer's HTML `content`; sanitised here, never stored as sent. */
  contentHtml: string | null;
  language: string | null;
  /** Null when the peer sent no `published`: the receive time is used. */
  publishedAt: Date | null;
  /** The peer's `updated`; null when it sent none. */
  editedAt: Date | null;
  raw: unknown;
};

/**
 * The post and parent comment a Note's `inReplyTo` names, by ap_id: the subject for
 * authorize('comment.create'). Null when the object is neither a post nor a comment here (the
 * caller skips the Note, or fetches the missing object first). Not locked: authorize() and the
 * recheck lock what the decision rests on.
 */
export async function resolveReplyTarget(
  inReplyToApId: string,
  q: Queryable = readDb(),
): Promise<{ postId: Uuid; parentId: Uuid | null } | null> {
  const [post] = await q.select({ id: posts.id }).from(posts).where(eq(posts.apId, inReplyToApId));
  if (post) return { postId: post.id, parentId: null };
  const [parent] = await q.select({ id: comments.id, postId: comments.postId }).from(comments).where(eq(comments.apId, inReplyToApId));
  return parent ? { postId: parent.postId, parentId: parent.id } : null;
}

/**
 * Stores a remote author's comment. A redelivered Create (another activity id, the same object)
 * changes nothing and answers created: false. The Markdown source is rendered like our own with
 * relative links meaning this instance, else the HTML is sanitised against the object's URL.
 * `distinguished` is not read from the document: it marks a moderator's comment, and an author
 * could otherwise mark their own. A reply to a comment on level 50 is refused by the policy
 * (comment.depth_exceeded) before this runs.
 */
export const storeRemoteComment = defineMutation({
  action: 'comment.create',
  emits: ['comment.created'],
  recheck: true,
  async run(t, grant, comment: RemoteComment) {
    if (grant.principal.kind !== 'remote')
      throw new TypeError("storeRemoteComment stores a remote author's comment; use createComment for a local one");
    const { postId, parentId } = grant.subject;
    const [existing] = await t.db.select({ id: comments.id }).from(comments).where(eq(comments.apId, comment.apId));
    if (existing) return { id: existing.id, created: false };
    // The Note must reply to what the grant names, or an authorized reply could be stored anywhere.
    const [target] = parentId
      ? await t.db.select({ apId: comments.apId }).from(comments).where(eq(comments.id, parentId))
      : await t.db.select({ apId: posts.apId }).from(posts).where(eq(posts.id, postId));
    if (target?.apId !== comment.inReplyToApId) throw new TypeError('storeRemoteComment: the record does not reply to the grant subject');
    const [author] = await t.db.select({ instanceId: actors.instanceId }).from(actors).where(eq(actors.id, grant.actorId));
    if (!author) throw new Refused('comment.create', 'auth.required');
    const { origin } = await localInstance(t.db);
    const id = uuidv7();
    await insertComment(
      t.db,
      { postId, parentId },
      {
        id,
        apId: comment.apId,
        local: false,
        instanceId: author.instanceId,
        raw: comment.raw,
        authorId: grant.actorId,
        ...remoteBody(comment, origin, id, comment.apId),
        language: comment.language,
        publishedAt: comment.publishedAt ?? new Date(),
        editedAt: comment.editedAt,
      },
    );
    await t.emit({ type: 'comment.created', v: 1, commentId: id, postId, authorId: grant.actorId, local: false, parentId });
    return { id, created: true };
  },
});

/** A peer's Update by the author: replaces the body, keeps `published`, the counts and the flags a moderator sets. */
export const updateRemoteComment = defineMutation({
  action: 'comment.update',
  emits: ['comment.updated'],
  recheck: true,
  async run(t, grant, record: RemoteComment) {
    const { commentId } = grant.subject;
    const [current] = await t.db.select().from(comments).where(eq(comments.id, commentId));
    if (!current) throw new Refused('comment.update', 'target.not_found');
    if (current.apId !== record.apId) throw new TypeError('updateRemoteComment: the record is not this comment');
    const { origin } = await localInstance(t.db);
    const body = remoteBody(record, origin, commentId, current.apId);
    // A peer's edit that only adds or drops a mention (the Mention tags in `raw`) changes who is notified: it is an edit too.
    const same =
      body.bodyMd === current.bodyMd &&
      body.contentHtml === current.contentHtml &&
      record.language === current.language &&
      sameMentions(current.raw, record.raw);
    if (same) return { id: commentId, changed: false };
    await t.db
      .update(comments)
      .set({ raw: record.raw, ...body, language: record.language, editedAt: record.editedAt ?? new Date() })
      .where(eq(comments.id, commentId));
    await t.emit({
      type: 'comment.updated',
      v: 1,
      commentId,
      postId: current.postId,
      authorId: current.authorId,
      local: false,
    });
    return { id: commentId, changed: true };
  },
});
