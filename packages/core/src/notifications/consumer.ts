import type { SystemPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { eq, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { comments, posts } from '../db/tables/content.ts';
import { findMentioned } from '../mentions/scan.ts';
import { defineConsumer, type ConsumerTx } from '../outbox/consumers.ts';
import { noticeBlocked } from './blocked.ts';
import { createNotification, purgeNotifications, type NotificationContext } from './mutations.ts';
import type { NotificationKind } from './view.ts';

// Turns events into inbox notices, in the batch transaction, from the rows as they are now:
// a notice for a comment since removed or deleted is never written. Every write is authorized
// as the `scheduled` system job and skips on a refusal, because a Refused would drop the whole
// event. The unique (recipient, cause) index makes a replay, or an edit that repeats a
// mention, write nothing.
//
// - A reply (comment.created): the parent comment's author, or the post's author for a
//   top-level comment. A mention (all four content events): a person of this instance named
//   with the full `@name@host` or a Mention tag (mentions/scan.ts). One person gets one notice
//   per comment or post, and a mention beats a reply.
// - Not for the author themselves, a recipient who is not a live local person, an object over a
//   week old (a backfill must not flood the inbox), or a recipient who blocks the author.
// - A moderator's removal or restore of someone's content and a ban or unban are told to the
//   affected local person whatever blocks and age say: they are owed the statement of reasons.
// - A deleted person's notices are purged.

/** Replies and mentions older than this are not news (a backfill or an old edit). */
const freshWindowMs = 7 * 24 * 60 * 60 * 1000;

const writeNotice = async (
  t: ConsumerTx,
  principal: SystemPrincipal,
  notice: { recipientId: Uuid; kind: NotificationKind; refId: Uuid; context: NotificationContext },
) => {
  const { recipientId, kind, refId, context } = notice;
  const decision = await authorize('notification.create', principal, { recipientId, kind, refId }, { db: t.db });
  if (!decision.ok) return;
  await createNotification.within(t, decision.grant, context);
};

/** True when the recipient blocks the author of a reply or mention. */
async function blocks(t: ConsumerTx, recipientId: Uuid, authorId: Uuid, communityId: Uuid): Promise<boolean> {
  const blocked = noticeBlocked({
    kind: sql`'reply'`,
    recipientId: sql`${recipientId}::uuid`,
    actorId: sql`${authorId}::uuid`,
    communityId: sql`${communityId}::uuid`,
  });
  const [row] = await t.db.execute<{ blocked: boolean }>(sql`select ${blocked} as blocked`);
  return row?.blocked === true;
}

type Content = {
  id: Uuid;
  authorId: Uuid;
  communityId: Uuid;
  postId: Uuid;
  /** Who a reply to this is for: the parent comment's author, or the post's author for a top-level comment. */
  replyTo: Uuid | null;
  context: NotificationContext;
};

/** The comment or post as it is now, or null when it is gone, deleted, removed or stale. */
async function liveContent(
  t: ConsumerTx,
  kind: 'comment' | 'post',
  id: Uuid,
): Promise<(Content & { bodyMd: string | null; raw: unknown }) | null> {
  const cutoff = new Date(Date.now() - freshWindowMs);
  if (kind === 'post') {
    const [post] = await t.db.select().from(posts).where(eq(posts.id, id));
    if (!post || post.deletedAt || post.removedAt || post.publishedAt < cutoff) return null;
    return {
      id,
      authorId: post.authorId,
      communityId: post.communityId,
      postId: id,
      replyTo: null,
      bodyMd: post.bodyMd,
      raw: post.raw,
      context: { actorId: post.authorId, communityId: post.communityId, postId: id, commentId: null, modlogId: null },
    };
  }
  const [row] = await t.db
    .select({ comment: comments, communityId: posts.communityId, postAuthorId: posts.authorId })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .where(eq(comments.id, id));
  if (!row || row.comment.deletedAt || row.comment.removedAt || row.comment.publishedAt < cutoff) return null;
  const { comment } = row;
  let replyTo: Uuid | null = row.postAuthorId;
  if (comment.parentId) {
    const [parent] = await t.db.select({ authorId: comments.authorId }).from(comments).where(eq(comments.id, comment.parentId));
    replyTo = parent?.authorId ?? null;
  }
  return {
    id,
    authorId: comment.authorId,
    communityId: row.communityId,
    postId: comment.postId,
    replyTo,
    bodyMd: comment.bodyMd,
    raw: comment.raw,
    context: { actorId: comment.authorId, communityId: row.communityId, postId: comment.postId, commentId: id, modlogId: null },
  };
}

async function contentNotices(t: ConsumerTx, kind: 'comment' | 'post', id: Uuid, replies: boolean): Promise<void> {
  const content = await liveContent(t, kind, id);
  if (!content) return;
  const mentioned = await findMentioned(t.db, { bodyMd: content.bodyMd, raw: content.raw, authorId: content.authorId });
  const recipients = new Map<Uuid, NotificationKind>(mentioned.map((recipient) => [recipient, 'mention']));
  if (replies && content.replyTo && content.replyTo !== content.authorId && !recipients.has(content.replyTo)) {
    recipients.set(content.replyTo, 'reply');
  }
  if (recipients.size === 0) return;
  const principal = await systemPrincipal(t.db, 'scheduled');
  for (const [recipientId, noticeKind] of recipients) {
    if (await blocks(t, recipientId, content.authorId, content.communityId)) continue;
    await writeNotice(t, principal, { recipientId, kind: noticeKind, refId: id, context: content.context });
  }
}

/** The author of a post or comment, when it still exists. */
async function authorOf(t: ConsumerTx, target: { kind: 'post' | 'comment'; id: Uuid }) {
  const table = target.kind === 'post' ? posts : comments;
  const [row] = await t.db.select({ authorId: table.authorId }).from(table).where(eq(table.id, target.id));
  return row?.authorId ?? null;
}

export const consumer = defineConsumer({
  name: 'notifications.create',
  events: ['comment.created', 'comment.updated', 'post.created', 'post.updated', 'mod.remove', 'mod.ban', 'actor.deleted'],
  emits: ['notification.created', 'notification.purged'],
  startAt: 'beginning',
  async handle(event, t) {
    switch (event.type) {
      case 'comment.created':
      case 'comment.updated':
        return contentNotices(t, 'comment', event.commentId, event.type === 'comment.created');
      case 'post.created':
      case 'post.updated':
        return contentNotices(t, 'post', event.postId, false);
      case 'mod.remove': {
        const authorId = await authorOf(t, event.target);
        if (!authorId || authorId === event.moderatorId) return;
        const [post] =
          event.target.kind === 'comment'
            ? await t.db.select({ postId: comments.postId }).from(comments).where(eq(comments.id, event.target.id))
            : [{ postId: event.target.id }];
        await writeNotice(t, await systemPrincipal(t.db, 'scheduled'), {
          recipientId: authorId,
          kind: event.removed ? 'mod_remove' : 'mod_restore',
          refId: event.modlogId,
          context: {
            actorId: event.moderatorId,
            communityId: event.communityId,
            postId: post?.postId ?? null,
            commentId: event.target.kind === 'comment' ? event.target.id : null,
            modlogId: event.modlogId,
          },
        });
        return;
      }
      case 'mod.ban':
        if (event.targetActorId === event.moderatorId) return;
        await writeNotice(t, await systemPrincipal(t.db, 'scheduled'), {
          recipientId: event.targetActorId,
          kind: event.banned ? 'ban' : 'unban',
          refId: event.modlogId,
          context: { actorId: event.moderatorId, communityId: event.communityId, postId: null, commentId: null, modlogId: event.modlogId },
        });
        return;
      case 'actor.deleted': {
        if (!event.local || event.kind !== 'Person') return;
        const decision = await authorize(
          'notification.purge',
          await systemPrincipal(t.db, 'scheduled'),
          { recipientId: event.actorId },
          { db: t.db },
        );
        if (decision.ok) await purgeNotifications.within(t, decision.grant, undefined);
        return;
      }
    }
  },
});
