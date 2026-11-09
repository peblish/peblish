import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, AuthorBadge, CommentView } from '@peblish/schema/views';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { readModlog } from '../modlog/read.ts';
import type { PostBody, Viewer } from '../posts/read.ts';
import { defaultThreadSort, inDisplayOrder, type ThreadSort } from './sort.ts';

// The read model of a comment thread: the flat list of CommentView the thread component takes,
// in display order (depth first, siblings in the sort's order), for a post or for the subtree
// under one comment (the "Continue this thread" page). It decides what a viewer may see: a
// deleted comment is a tombstone, a removed one shows only that (a moderator also gets the
// modlog reason), in one place so no page can forget it. The post's own gate (sensitive
// content, a removed post) is the page's: it calls readPost and asks for a thread only when
// the post is shown.
//
// A thread is cut three ways, so a page's cost does not grow with a thread:
// - depth: only `threadDisplayDepth` levels are read (counting from the comment a permalink
//   starts at). A comment on the last level carries counts.comments, all the replies under
//   it, so the component can offer "Continue this thread" with the number.
// - rows: at most `threadFetchLimit` rows are read, in path order, which keeps every parent
//   before its children, so what is read is always a whole tree.
// - shown: at most `threadMaxComments` of them are sent, the first in display order.
// `truncated` says that rows were left out by the last two.

/** Levels sent and drawn (the thread component's maxDepth). A permalink page shows this many below its comment too. */
export const threadDisplayDepth = 6;
/** Comments a thread page sends, as Lemmy's default page size. */
export const threadMaxComments = 300;
/** Rows read for one thread, however many are then shown. */
export const threadFetchLimit = 2_000;

/** What to render for a comment's text: the web renderer takes Markdown through render, remote HTML through sanitize. */
export type CommentBody = PostBody;

export type ThreadComment = {
  /** contentHtml is null: the page renders `body` (createMarkdownRenderer) and fills it. */
  view: CommentView;
  /** Null when the comment has no text or the viewer is not shown it (deleted, removed). */
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
  /** Comments within the depth that are not in `comments`: the thread has more than a page. */
  truncated: boolean;
};

type Row = {
  id: Uuid;
  apId: string;
  authorId: Uuid;
  parentId: Uuid | null;
  path: string;
  upvotes: number;
  downvotes: number;
  publishedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  removedAt: Date | null;
  /** Every comment under this one, however deep (a tombstone counts): comments.child_count. */
  childCount: number;
};

const level = (path: string) => path.split('.').length;

/**
 * The comments to lay out, without their text (a page shows a fraction of them): those of the
 * post, or under `from`, within the depth, in path order, which is an index scan on
 * comments_post_path and keeps every parent before its children.
 */
async function rowsOf(q: Queryable, postId: Uuid, from: { path: string } | null): Promise<Row[]> {
  const maxLevel = (from ? level(from.path) : 1) + threadDisplayDepth - 1;
  return q
    .select({
      id: comments.id,
      apId: comments.apId,
      authorId: comments.authorId,
      parentId: comments.parentId,
      path: comments.path,
      upvotes: comments.upvotes,
      downvotes: comments.downvotes,
      publishedAt: comments.publishedAt,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      removedAt: comments.removedAt,
      childCount: comments.childCount,
    })
    .from(comments)
    .where(
      and(
        eq(comments.postId, postId),
        sql`nlevel(${comments.path}) <= ${maxLevel}`,
        from ? sql`${comments.path} <@ ${from.path}::ltree` : undefined,
      ),
    )
    .orderBy(comments.path)
    .limit(threadFetchLimit);
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
 * A post's thread, or the subtree under `rootId` (the comment itself and what is below it).
 * Null when the post does not exist, its community is gone, or `rootId` is not a comment of
 * this post. Run it only for a post the viewer is shown.
 */
export async function readThread(
  postId: Uuid,
  viewer: Viewer,
  options: { sort?: ThreadSort; rootId?: Uuid | null; now?: Date; db?: Queryable } = {},
): Promise<Thread | null> {
  const { sort = defaultThreadSort, rootId = null, now = new Date(), db: q = db() } = options;
  const [post] = await q.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, postId));
  if (!post) return null;
  let focus: { id: Uuid; parentId: Uuid | null; path: string } | null = null;
  if (rootId) {
    const [root] = await q
      .select({ id: comments.id, parentId: comments.parentId, path: comments.path, postId: comments.postId })
      .from(comments)
      .where(eq(comments.id, rootId));
    if (root?.postId !== postId) return null;
    focus = root;
  }
  const rows = await rowsOf(q, postId, focus);
  const ordered = inDisplayOrder(rows, sort, now);
  const shown = ordered.slice(0, threadMaxComments);
  const [context, texts] = await Promise.all([loadContext(q, postId, post.communityId, shown, viewer), textsOf(q, shown)]);
  const removed = new Set(shown.filter((row) => row.removedAt !== null && row.deletedAt === null).map((row) => row.id));
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
      },
      body: texts.get(row.id) ?? null,
      removal: removed.has(row.id) && context.moderator ? { reason: reasons.get(row.id) ?? null } : null,
    };
  });
  return {
    postId,
    sort,
    comments: entries,
    focus: focus && { id: focus.id, parentId: focus.parentId },
    moderator: context.moderator,
    truncated: ordered.length > shown.length || rows.length === threadFetchLimit,
  };
}
