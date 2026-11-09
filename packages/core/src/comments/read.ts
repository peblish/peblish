import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, AuthorBadge, CommentView } from '@peblish/schema/views';
import { and, eq, inArray } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { blockedAmong } from '../blocks/predicate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { readModlog } from '../modlog/read.ts';
import type { PostBody, Viewer } from '../posts/read.ts';
import { decodeCursor, encodeCursor, type ThreadCursor } from './cursor.ts';
import { threadDisplayDepth, threadMaxComments, threadPageSize, threadReplyPreview } from './limits.ts';
import { repliesUnder, rowColumns, siblingsPage, type Keyed, type Row } from './siblings.ts';
import { defaultThreadSort, type ThreadSort } from './sort.ts';

// The read model of a comment thread: the flat list of CommentView the thread component takes,
// in display order (depth first, siblings in the sort's order), for a post or for the subtree
// under one comment (the "Continue this thread" page). It decides what a viewer may see: a
// deleted comment is a tombstone, a removed one shows only that (a moderator also gets the
// modlog reason), in one place so no page can forget it. The post's own gate (sensitive
// content, a removed post) is the page's: it calls readPost and asks for a thread only when
// the post is shown.
//
// A page is cut three ways, so its cost does not grow with a thread, and nothing it leaves out
// is out of reach:
// - siblings: the set a page pages (the post's top-level comments, or the replies under a
//   permalink's comment) lists `threadPageSize` of them in the sort's order, chosen in SQL
//   before the limit, and `next` is the cursor for the following page. Every other comment
//   lists its first `threadReplyPreview` replies.
// - depth: only `threadDisplayDepth` levels are read (counting from the comment a permalink
//   starts at), and at most `threadMaxComments` comments in all, level by level, so the
//   top of the thread fills first.
// - what is cut: a comment's counts.comments is every comment under it, so the component
//   knows how many replies of a comment the page left out and links to the comment's own
//   page, which pages them in turn.

/** What to render for a comment's text: the web renderer takes Markdown through render, remote HTML through sanitize. */
export type CommentBody = PostBody;

export type ThreadComment = {
  /** contentHtml is null: the page renders `body` (createMarkdownRenderer) and fills it. */
  view: CommentView;
  /** Null when the comment has no text or the viewer is not shown it (deleted, removed, or by someone the viewer blocks). */
  body: CommentBody | null;
  /** Set for a moderator looking at a removed comment: why, from the modlog (null when none was given or it is withheld). */
  removal: { reason: string | null } | null;
};

export type Thread = {
  postId: Uuid;
  sort: ThreadSort;
  comments: ThreadComment[];
  /** The comment a permalink page starts from, else null. */
  focus: { id: Uuid; parentId: Uuid | null } | null;
  /** The viewer is a site admin or a moderator or owner of the post's community. */
  moderator: boolean;
  /** The cursor for the next page of the siblings this page lists (`readThread`'s `after`), or null on the last. */
  next: string | null;
};

/**
 * The comments to lay out, in display order (depth first), read level by level: the page of
 * siblings, then the first replies under each comment of the level above, until the depth or
 * the budget of comments runs out.
 */
async function layout(q: Queryable, focus: Row | null, siblings: readonly Row[], sort: ThreadSort, asOf: number) {
  const levels: Row[][] = focus ? [[focus], [...siblings]] : [[...siblings]];
  let count = levels.flat().length;
  while (levels.length < threadDisplayDepth && count < threadMaxComments) {
    const above = levels.at(-1) ?? [];
    const found = await repliesUnder(
      q,
      above.map(({ id }) => id),
      { sort, asOf, perParent: threadReplyPreview, limit: threadMaxComments - count },
    );
    if (found.length === 0) break;
    levels.push(found);
    count += found.length;
  }
  // Each level lists the replies of the level above in that level's order, so grouping them by parent keeps every order.
  const replies = new Map<Uuid, Row[]>();
  for (const row of levels.slice(1).flat()) {
    if (row.parentId === null) continue;
    const list = replies.get(row.parentId);
    if (list) list.push(row);
    else replies.set(row.parentId, [row]);
  }
  const ordered: Row[] = [];
  // An explicit stack: a chain 50 deep is fine for recursion, but nothing here depends on that.
  const stack = [...(levels[0] ?? [])].reverse();
  for (let row = stack.pop(); row; row = stack.pop()) {
    ordered.push(row);
    const below = replies.get(row.id);
    if (below) stack.push(...[...below].reverse());
  }
  return ordered;
}

/** The text of the comments that are shown and live: a deleted or removed comment's text is never read. */
async function textsOf(q: Queryable, rows: readonly Row[]): Promise<Map<Uuid, CommentBody>> {
  const live = rows.filter((row) => row.deletedAt === null && row.removedAt === null);
  const found =
    live.length === 0
      ? []
      : await q
          .select({ id: comments.id, apId: comments.apId, bodyMd: comments.bodyMd, contentHtml: comments.contentHtml })
          .from(comments)
          .where(
            inArray(
              comments.id,
              live.map((row) => row.id),
            ),
          );
  return new Map(
    found.flatMap((row): [Uuid, CommentBody][] =>
      row.bodyMd
        ? [[row.id, { kind: 'markdown', source: row.bodyMd }]]
        : row.contentHtml
          ? [[row.id, { kind: 'html', html: row.contentHtml, baseUrl: row.apId }]]
          : [],
    ),
  );
}

/** The people behind the comments, their badges, the viewer's votes and the modlog reasons moderators see. */
async function loadContext(q: Queryable, postId: Uuid, communityId: Uuid, rows: readonly Row[], viewer: Viewer) {
  const authorIds = [...new Set(rows.map((row) => row.authorId))];
  const empty = rows.length === 0;
  const [people, admins, moderators, mine, viewerRole] = await Promise.all([
    empty
      ? []
      : q
          .select({
            id: actors.id,
            apId: actors.apId,
            kind: actors.kind,
            name: actors.name,
            displayName: actors.displayName,
            local: actors.local,
            domain: instances.domain,
          })
          .from(actors)
          .innerJoin(instances, eq(instances.id, actors.instanceId))
          .where(inArray(actors.id, authorIds)),
    // An admin badge needs two-factor on, like siteRole: an admin without it acts as a user.
    empty
      ? []
      : q
          .select({ id: actors.id })
          .from(actors)
          .innerJoin(authUser, eq(authUser.id, actors.userId))
          .where(and(inArray(actors.id, authorIds), eq(authUser.role, 'admin'), eq(authUser.twoFactorEnabled, true))),
    empty
      ? []
      : q
          .select({ moderatorId: communityModerators.moderatorId })
          .from(communityModerators)
          .where(
            and(eq(communityModerators.communityId, communityId), inArray(communityModerators.moderatorId, authorIds), freshModerator),
          ),
    // The viewer's votes are few: their index (voter, comment) finds them, the join keeps this post's.
    viewer && !empty
      ? q
          .select({ commentId: votes.commentId, value: votes.value })
          .from(votes)
          .innerJoin(comments, eq(comments.id, votes.commentId))
          .where(and(eq(votes.voterId, viewer.actorId), eq(comments.postId, postId)))
      : [],
    viewer && viewer.siteRole !== 'admin'
      ? q
          .select({ moderatorId: communityModerators.moderatorId })
          .from(communityModerators)
          .where(and(eq(communityModerators.communityId, communityId), eq(communityModerators.moderatorId, viewer.actorId), freshModerator))
      : [],
  ]);
  const authors = new Map<Uuid, ActorRef>(
    people.map(({ domain, ...actor }) => [actor.id, { ...actor, handle: actor.local ? actor.name : `${actor.name}@${domain}` }]),
  );
  return {
    authors,
    admins: new Set(admins.map(({ id }) => id)),
    moderators: new Set(moderators.map(({ moderatorId }) => moderatorId)),
    mine: new Map(mine.flatMap(({ commentId, value }) => (commentId ? [[commentId, value === 1 ? 1 : -1] as const] : []))),
    moderator: viewer?.siteRole === 'admin' || viewerRole.length > 0,
  };
}

/** Why each removed comment was removed, from the modlog (newest removal first), for the moderators who may see it. */
async function removalReasons(q: Queryable, communityId: Uuid, removed: ReadonlySet<Uuid>): Promise<Map<Uuid, string | null>> {
  const entries = await readModlog({ communityId, action: 'mod.remove', limit: 200 }, { audience: 'staff', db: q });
  const reasons = new Map<Uuid, string | null>();
  for (const entry of entries) {
    const target = entry.targetCommentId;
    if (target && removed.has(target) && !reasons.has(target)) reasons.set(target, entry.reason);
  }
  return reasons;
}

/**
 * A page of a post's thread, or of the subtree under `rootId` (the comment itself and what is
 * below it). The siblings it pages are the post's top-level comments, or the replies to
 * `rootId`; `after` is a previous page's `next`, and one that does not belong to this sort and
 * this set of siblings starts again at the first page. Null when the post does not exist, its
 * community is gone, or `rootId` is not a comment of this post. Run it only for a post the
 * viewer is shown.
 */
export async function readThread(
  postId: Uuid,
  viewer: Viewer,
  options: { sort?: ThreadSort; rootId?: Uuid | null; after?: string | null; now?: Date; db?: Queryable } = {},
): Promise<Thread | null> {
  const { sort = defaultThreadSort, rootId = null, after = null, now = new Date(), db: q = db() } = options;
  const [post] = await q.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, postId));
  if (!post) return null;
  let focus: Row | null = null;
  if (rootId) {
    const [root] = await q
      .select({ ...rowColumns, postId: comments.postId })
      .from(comments)
      .where(eq(comments.id, rootId));
    if (root?.postId !== postId) return null;
    focus = root;
  }
  const cursor = decodeCursor(after, sort, rootId);
  const asOf = cursor?.asOf ?? now.getTime();
  const found = await siblingsPage(q, { postId, parentId: rootId }, { sort, asOf, cursor, want: threadPageSize + 1 });
  const siblings = found.slice(0, threadPageSize);
  const last = siblings.at(-1);
  const next = found.length > threadPageSize && last ? encodeCursor(cursorAfter(last, sort, rootId, asOf)) : null;

  const shown = await layout(q, focus, siblings, sort, asOf);
  const [context, texts, blocked] = await Promise.all([
    loadContext(q, postId, post.communityId, shown, viewer),
    textsOf(q, shown),
    viewer ? blockedAmong(q, viewer.actorId, [...new Set(shown.map((row) => row.authorId))]) : new Set<Uuid>(),
  ]);
  // A live comment by someone the viewer blocks stays in place with its text withheld and its
  // replies kept, so the parent's reply count still points at something. A permalink's own
  // comment is read on purpose.
  const hidden = (row: Row) => row.deletedAt === null && row.removedAt === null && blocked.has(row.authorId) && row.id !== focus?.id;
  const removed = new Set(shown.filter((row) => row.removedAt !== null).map((row) => row.id));
  const reasons = context.moderator && removed.size > 0 ? await removalReasons(q, post.communityId, removed) : new Map();
  const entries = shown.map((row): ThreadComment => {
    const author = context.authors.get(row.authorId);
    if (!author) throw new Error(`comment ${row.id} names an author that is gone`);
    const badge: AuthorBadge = context.admins.has(author.id) ? 'admin' : context.moderators.has(author.id) ? 'moderator' : null;
    return {
      view: {
        id: row.id,
        apId: row.apId,
        postId,
        parentId: row.parentId,
        depth: level(row.path) - 1,
        contentHtml: null,
        author,
        authorBadge: badge,
        publishedAt: row.publishedAt.toISOString(),
        editedAt: row.editedAt?.toISOString() ?? null,
        deleted: row.deletedAt !== null,
        removed: row.removedAt !== null,
        counts: { upvotes: row.upvotes, downvotes: row.downvotes, comments: row.childCount },
        myVote: context.mine.get(row.id) ?? 0,
        ...(hidden(row) ? { blocked: true } : {}),
      },
      body: hidden(row) ? null : (texts.get(row.id) ?? null),
      removal: removed.has(row.id) && context.moderator ? { reason: reasons.get(row.id) ?? null } : null,
    };
  });
  return {
    postId,
    sort,
    comments: entries,
    focus: focus && { id: focus.id, parentId: focus.parentId },
    moderator: context.moderator,
    next,
  };
}

const level = (path: string) => path.split('.').length;

function cursorAfter(row: Keyed, sort: ThreadSort, parent: Uuid | null, asOf: number): ThreadCursor {
  const position = { v: 1, sort, parent, asOf, pub: row.pub, id: row.id } as const;
  if (sort === 'top') return { ...position, score: row.score };
  if (sort === 'hot') return { ...position, rank: row.rank };
  return position;
}
