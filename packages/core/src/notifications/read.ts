import { Uuid } from '@peblish/schema/ids';
import { excerptLength } from '@peblish/schema/markdown';
import { aliasedTable, and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { renderMarkdown } from '../markdown/render.ts';
import { sanitizeRemoteHtml } from '../markdown/sanitize.ts';
import { readModlogEntries } from '../modlog/read.ts';
import type { Viewer } from '../posts/read.ts';
import { notifications } from './tables.ts';
import { unreadCountOf } from './unread.ts';
import { inboxVisible } from './visible.ts';
import {
  filterKinds,
  type Inbox,
  type InboxFilter,
  type InboxItem,
  type NoticeActor,
  type NoticeWithheld,
  type UnreadByGroup,
} from './view.ts';

// The read model of the inbox (the notifications-list pick): one page of the viewer's notices,
// newest first, with what each is about. It decides what a notice may show, in one place: a
// post or community that is sensitive or NSFL shows only that for every viewer (a notice must
// not carry what the gate would hide), a removed or deleted comment shows only that word, and a
// removed or deleted post loses its title too. A page is a handful of queries however many rows
// it lists: the notices, their people, their posts and comments, and their modlog entries.

export const inboxPageSize = 25;

/** Characters of text a row shows; the page clamps it to two lines. */
const noticeExcerptLength = Math.min(excerptLength, 200);

type PostRow = {
  id: Uuid;
  title: string;
  bodyMd: string | null;
  contentHtml: string | null;
  /** The post or its community is sensitive or NSFL. */
  hidden: boolean;
  deletedAt: Date | null;
  removedAt: Date | null;
};
type CommentRow = {
  id: Uuid;
  postId: Uuid;
  parentId: Uuid | null;
  bodyMd: string | null;
  contentHtml: string | null;
  deletedAt: Date | null;
  removedAt: Date | null;
};

const asActor = (row: { id: string; name: string; displayName: string | null; local: boolean; domain: string }): NoticeActor => ({
  id: row.id,
  name: row.name,
  displayName: row.displayName,
  handle: row.local ? row.name : `${row.name}@${row.domain}`,
  local: row.local,
});

/** Plain text of a body, short: our Markdown rendered, a peer's HTML sanitised. Null when there is none. */
function excerptOf(body: { bodyMd: string | null; contentHtml: string | null }, origin: string): string | null {
  const text = body.bodyMd
    ? renderMarkdown(body.bodyMd, { baseOrigin: origin, excerptLength: noticeExcerptLength }).excerpt
    : body.contentHtml
      ? sanitizeRemoteHtml(body.contentHtml, { excerptLength: noticeExcerptLength }).excerpt
      : '';
  return text.trim() === '' ? null : text;
}

/**
 * The viewer's inbox, newest first: `limit` notices after `cursor` (the last id of the page
 * before; uuidv7 ids are in creation order), filtered by `filter`. Which notices exist is
 * inboxVisible's (no blocked author's reply or mention, nothing in a deleted or removed
 * community), shared with every count. `unread` is the shell's badge number and
 * `unreadByGroup` the filter links', both capped.
 */
export async function readInbox(
  viewer: NonNullable<Viewer>,
  options: { filter?: InboxFilter; cursor?: string | null; limit?: number } = {},
  q: Queryable = db(),
): Promise<Inbox> {
  const { filter = 'all', cursor = null, limit = inboxPageSize } = options;
  const conditions: (SQL | undefined)[] = [
    inboxVisible(viewer.actorId),
    filter === 'all' || filter === 'unread' ? undefined : inArray(notifications.kind, [...filterKinds[filter]]),
    filter === 'unread' ? isNull(notifications.readAt) : undefined,
    cursor !== null && Uuid.allows(cursor) ? lt(notifications.id, cursor) : undefined,
  ];
  const [rows, unread, unreadByGroup] = await Promise.all([
    q
      .select({ notice: notifications })
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.id))
      .limit(limit + 1),
    unreadCountOf(q, viewer.actorId),
    groupCounts(q, viewer.actorId),
  ]);
  const page = rows.slice(0, limit).map(({ notice }) => notice);
  const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  return { items: await describe(q, page), next, unread, unreadByGroup };
}

async function groupCounts(q: Queryable, viewerId: Uuid): Promise<UnreadByGroup> {
  const [replies, mentions, content, account] = await Promise.all(
    (['replies', 'mentions', 'content', 'account'] as const).map((group) => unreadCountOf(q, viewerId, filterKinds[group])),
  );
  return { replies: replies!, mentions: mentions!, content: content!, account: account! };
}

/** The rows as items: who, where, what it says (or why it says nothing) and the moderator's statement. */
async function describe(q: Queryable, rows: (typeof notifications.$inferSelect)[]): Promise<InboxItem[]> {
  if (rows.length === 0) return [];
  const actorIds = [...new Set(rows.flatMap((row) => [row.actorId, row.communityId]).filter((id) => id !== null))];
  const commentIds = rows.flatMap((row) => (row.commentId ? [row.commentId] : []));
  const postIds = rows.flatMap((row) => (row.postId ? [row.postId] : []));
  const modlogIds = rows.flatMap((row) => (row.modlogId ? [row.modlogId] : []));
  const [people, commentRows, postRows, entries, instance] = await Promise.all([
    actorIds.length === 0
      ? []
      : q
          .select({ id: actors.id, name: actors.name, displayName: actors.displayName, local: actors.local, domain: instances.domain })
          .from(actors)
          .innerJoin(instances, eq(instances.id, actors.instanceId))
          .where(inArray(actors.id, actorIds)),
    commentIds.length === 0
      ? []
      : q
          .select({
            id: comments.id,
            postId: comments.postId,
            parentId: comments.parentId,
            bodyMd: comments.bodyMd,
            contentHtml: comments.contentHtml,
            deletedAt: comments.deletedAt,
            removedAt: comments.removedAt,
          })
          .from(comments)
          .where(inArray(comments.id, commentIds)),
    postIds.length === 0 ? [] : postsOf(q, postIds),
    // Staff sees every entry: the person it affects is owed the reason, public or not (the page links only public ones).
    readModlogEntries(modlogIds, { audience: 'staff', db: q }),
    localInstance(q),
  ]);
  const personById = new Map(people.map((row) => [row.id, asActor(row)]));
  const commentById = new Map<string, CommentRow>(commentRows.map((row) => [row.id, row]));
  const postById = new Map<string, PostRow>(postRows.map((row) => [row.id, row]));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  return rows.map((row): InboxItem => {
    const comment = row.commentId ? commentById.get(row.commentId) : undefined;
    const post = postById.get(row.postId ?? comment?.postId ?? '');
    const text = comment ?? (row.commentId ? undefined : post);
    const withheld = withheldOf(text ? { comment: comment ?? null, post: post ?? null } : null);
    const entry = row.modlogId ? entryById.get(row.modlogId) : undefined;
    return {
      id: row.id,
      kind: row.kind,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
      actor: (row.actorId && personById.get(row.actorId)) || null,
      community: (row.communityId && personById.get(row.communityId)) || null,
      postId: row.postId,
      commentId: row.commentId,
      postTitle: titleOf(post),
      about: row.commentId ? 'comment' : row.postId ? 'post' : null,
      replyTo: row.kind === 'reply' ? (comment?.parentId ? 'comment' : 'post') : null,
      withheld,
      excerpt: text && withheld === null ? excerptOf(text, instance.origin) : null,
      statement: entry ? { modlogId: entry.id, reason: entry.reason, reasonWithheld: entry.reasonWithheld, public: entry.public } : null,
    };
  });
}

/** The posts with the flags that decide whether a notice about them may show text: their own and their community's. */
async function postsOf(q: Queryable, ids: Uuid[]): Promise<PostRow[]> {
  const community = aliasedTable(actors, 'community');
  const rows = await q
    .select({
      id: posts.id,
      title: posts.title,
      bodyMd: posts.bodyMd,
      contentHtml: posts.contentHtml,
      deletedAt: posts.deletedAt,
      removedAt: posts.removedAt,
      sensitive: posts.sensitive,
      nsfl: posts.nsfl,
      communitySensitive: community.sensitive,
      communityNsfl: community.nsfl,
    })
    .from(posts)
    .innerJoin(community, eq(community.id, posts.communityId))
    .where(inArray(posts.id, ids));
  return rows.map(({ sensitive, nsfl, communitySensitive, communityNsfl, ...row }) => ({
    ...row,
    hidden: sensitive || nsfl || communitySensitive || communityNsfl,
  }));
}

/**
 * The post's title, when a notice may show it: not for sensitive content (the gate hides it from
 * everyone), and not once the post is removed or deleted, whatever the notice is about. A
 * removal notice still carries the moderator's statement; only the title goes.
 */
const titleOf = (post: PostRow | undefined): string | null =>
  post && !post.hidden && post.removedAt === null && post.deletedAt === null ? post.title : null;

/**
 * Why a notice about this text shows a word instead: sensitive content first (the gate hides it
 * from everyone, so the inbox does too), then a comment or post removed or deleted since.
 */
function withheldOf(subject: { comment: CommentRow | null; post: PostRow | null } | null): NoticeWithheld | null {
  if (!subject) return null;
  const { comment, post } = subject;
  if (post?.hidden) return 'sensitive';
  const gone = comment ?? post;
  if (!gone) return null;
  if (gone.deletedAt || post?.deletedAt) return 'deleted';
  if (gone.removedAt || post?.removedAt) return 'removed';
  return null;
}
