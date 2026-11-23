import { Uuid } from '@peblish/schema/ids';
import { excerptLength } from '@peblish/schema/markdown';
import { aliasedTable, and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import { gateOf } from '../communities/gate.ts';
import { moderatedAmong } from '../communities/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { ageDeclarations } from '../identity/tables.ts';
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
  type NoticeActorWithheld,
  type NoticeWithheld,
  type UnreadByGroup,
} from './view.ts';

// The read model of the inbox (the notifications-list pick): one page of the viewer's notices,
// newest first, with what each is about. It decides what a notice may show, in one place: a
// post or community that is sensitive or NSFL shows only that for every viewer (a notice must
// not carry what the gate would hide), a removed or deleted comment shows only that word, and a
// removed or deleted post loses its title too. Who wrote a reply or mention follows the thread:
// sensitive content the viewer has not declared 16+ for (whatever became of it since), a removed
// or deleted comment and a removed or deleted post name no one (actorWithheldOf), and such a
// notice keeps no comment id to look its author up by. A page is a handful of queries however many rows it lists: the notices,
// their people, their posts and comments, their modlog entries and the viewer's declaration.

export const inboxPageSize = 25;

/** Characters of text a row shows; the page clamps it to two lines. */
const noticeExcerptLength = Math.min(excerptLength, 200);

type PostRow = {
  id: Uuid;
  communityId: Uuid;
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
 *
 * The rows and what each says are read from one snapshot (inboxPage); the counts beside it, at
 * the same time, by the same rule.
 */
export async function readInbox(
  viewer: NonNullable<Viewer>,
  options: { filter?: InboxFilter; cursor?: string | null; limit?: number } = {},
  q?: Queryable,
): Promise<Inbox> {
  const counted = q ?? db();
  const [page, unread, unreadByGroup] = await Promise.all([
    q
      ? inboxPage(q, viewer, options)
      : db().transaction((snapshot) => inboxPage(snapshot, viewer, options), {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        }),
    unreadCountOf(counted, viewer.actorId),
    groupCounts(counted, viewer.actorId),
  ]);
  return { ...page, unread, unreadByGroup };
}

/**
 * One page of rows and their descriptions. readInbox runs it in a read-only REPEATABLE READ
 * transaction: every statement in it reads the snapshot its first took, so a row is described
 * from the same data it was chosen by, even when its comment is purged, or a block made, while the
 * page is read. Read-only, it takes no locks and cannot fail to serialize. A caller passing its
 * own `q` passes one snapshot.
 */
async function inboxPage(
  q: Queryable,
  viewer: NonNullable<Viewer>,
  { filter = 'all', cursor = null, limit = inboxPageSize }: { filter?: InboxFilter; cursor?: string | null; limit?: number },
): Promise<Pick<Inbox, 'items' | 'next'>> {
  const conditions: (SQL | undefined)[] = [
    inboxVisible(viewer.actorId),
    filter === 'all' || filter === 'unread' ? undefined : inArray(notifications.kind, [...filterKinds[filter]]),
    filter === 'unread' ? isNull(notifications.readAt) : undefined,
    cursor !== null && Uuid.allows(cursor) ? lt(notifications.id, cursor) : undefined,
  ];
  const rows = await q
    .select({ notice: notifications })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(({ notice }) => notice);
  const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  // A followed thread's notice is listed only with nothing withheld (inboxVisible), so it names its commenter as a reply does.
  return { items: await describe(q, page, viewer), next };
}

async function groupCounts(q: Queryable, viewerId: Uuid): Promise<UnreadByGroup> {
  const [replies, mentions, content, account] = await Promise.all(
    (['replies', 'mentions', 'content', 'account'] as const).map((group) => unreadCountOf(q, viewerId, filterKinds[group])),
  );
  return { replies: replies!, mentions: mentions!, content: content!, account: account! };
}

/** The rows as items: who, where, what it says (or why it says nothing) and the moderator's statement. */
async function describe(q: Queryable, rows: (typeof notifications.$inferSelect)[], viewer: NonNullable<Viewer>): Promise<InboxItem[]> {
  const viewerId = viewer.actorId;
  if (rows.length === 0) return [];
  const actorIds = [...new Set(rows.flatMap((row) => [row.actorId, row.communityId]).filter((id) => id !== null))];
  const commentIds = rows.flatMap((row) => (row.commentId ? [row.commentId] : []));
  const postIds = rows.flatMap((row) => (row.postId ? [row.postId] : []));
  const modlogIds = rows.flatMap((row) => (row.modlogId ? [row.modlogId] : []));
  const [people, commentRows, postRows, entries, instance, declaration] = await Promise.all([
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
    q.select({ actorId: ageDeclarations.actorId }).from(ageDeclarations).where(eq(ageDeclarations.actorId, viewerId)),
  ]);
  const declared = declaration.length > 0;
  // The staff of a post's community (and site admins) are told who wrote what is removed or deleted there, as its pages tell them.
  const communityIds = [...new Set(postRows.map((row) => row.communityId))];
  const staffOf = viewer.siteRole === 'admin' ? new Set(communityIds) : await moderatedAmong(viewerId, communityIds, q);
  const personById = new Map(people.map((row) => [row.id, asActor(row)]));
  const commentById = new Map<string, CommentRow>(commentRows.map((row) => [row.id, row]));
  const postById = new Map<string, PostRow>(postRows.map((row) => [row.id, row]));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  return rows.map((row): InboxItem => {
    const comment = row.commentId ? commentById.get(row.commentId) : undefined;
    const post = postById.get(row.postId ?? comment?.postId ?? '');
    // A reply's or mention's ref is the comment or post itself. Once that row is purged its link
    // goes null, but what is left (the post it was under) is not what the notice was about: it
    // names no one and quotes nothing, for staff as well.
    const gone = (row.kind === 'reply' || row.kind === 'mention') && !commentById.has(row.refId) && !postById.has(row.refId);
    const text = gone ? undefined : (comment ?? (row.commentId ? undefined : post));
    const withheld = gone ? 'deleted' : withheldOf(text ? { comment: comment ?? null, post: post ?? null } : null);
    const entry = row.modlogId ? entryById.get(row.modlogId) : undefined;
    const actorWithheld = gone
      ? 'deleted'
      : actorWithheldOf(row.kind, comment, post, { declared, staff: post !== undefined && staffOf.has(post.communityId) });
    return {
      id: row.id,
      kind: row.kind,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
      actor: actorWithheld ? null : (row.actorId && personById.get(row.actorId)) || null,
      actorWithheld,
      community: (row.communityId && personById.get(row.communityId)) || null,
      // A notice that names no one keeps no comment or post id: the comment's leads to its author, and
      // the post's to a title and an author elsewhere (the public modlog). The row links to the community.
      postId: actorWithheld ? null : row.postId,
      commentId: actorWithheld ? null : row.commentId,
      // A notice that names no one shows no title either: the title of the post it answers can name its author.
      postTitle: actorWithheld ? null : titleOf(post),
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
      communityId: posts.communityId,
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

/**
 * Whether a reply or mention may say who wrote it, as the thread and the post page decide for the
 * same text: a sensitive post or community shows a viewer without a 16+ declaration nothing at
 * all (gateOf, the post page's rule; an access rule, so the browser's Hide NSFW plays no part), so
 * for them it is 'sensitive' whatever became of the comment or post, as for live content. Past
 * the gate, a deleted or removed comment is a tombstone without its author. Under a post a
 * moderator removed, the page sends no comments, and a removed or deleted post names no author,
 * so a comment there and a mention in such a post name no one either. The community's staff
 * (`staff`: its moderators and the site admins) are told for removed and deleted content, as its
 * pages tell them; the age gate holds for them too, as the page's does. A declared viewer is named the author: Hide
 * NSFW is a prompt they pass on the page, which then shows who wrote it (the words stay withheld
 * here for everyone, as `withheld` says). A reply under a deleted post keeps its author, as the
 * thread shows it. A moderator's notice (removal, restore, ban) names the moderator, whatever it
 * is about.
 */
function actorWithheldOf(
  kind: InboxItem['kind'],
  comment: CommentRow | undefined,
  post: PostRow | undefined,
  { declared, staff }: { declared: boolean; staff: boolean },
): NoticeActorWithheld | null {
  if (kind !== 'reply' && kind !== 'mention') return null;
  // The gate first: a viewer it stops is shown nothing of the post, so not what became of it either.
  if (post && gateOf(post.hidden, { declared }, true) !== 'none') return 'sensitive';
  if (staff) return null;
  if (comment?.deletedAt) return 'deleted';
  if (comment?.removedAt || (comment && post?.removedAt)) return 'removed';
  // A mention in the post itself: the post page withholds the author of a deleted or removed post.
  if (!comment && post?.deletedAt) return 'deleted';
  if (!comment && post?.removedAt) return 'removed';
  return null;
}
