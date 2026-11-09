import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, CommentView, Page, PostView } from '@peblish/schema/views';
import { and, count, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { blockOf } from '../blocks/predicate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { decodeCursor, encodeCursor, type Cursor } from '../feeds/cursor.ts';
import { defaultPageSize, maxPageSize } from '../feeds/input.ts';
import { visible } from '../feeds/read.ts';
import { postViews, type PostBody, type Viewer } from '../posts/read.ts';
import type { ProfileSort, ProfileTab } from './input.ts';

// The read model of a profile page (S18): who the person is, and their posts and comments for
// the viewer. Activity goes through the feed query's own conditions (`visible`), so the NSFW
// gate, removed communities and the viewer's blocks apply as they do in every feed.

export type Profile = {
  actor: ActorRef;
  /** The raw avatar URL: pages pass it through the renderer's `image()`. */
  iconUrl: string | null;
  /** Markdown for a local person, sanitised-on-render HTML for a remote one; null when empty or the account is deleted. */
  bio: PostBody | null;
  /** When the account began: the remote's own publish time when known, else when it was stored here. */
  joinedAt: string;
  /** Live posts and comments, whoever may see them: the tabs list what this viewer is shown. */
  counts: { posts: number; comments: number };
  /** `admin` needs two-factor on, as the thread's badge does; `moderator` is any community with a current role. */
  badges: { admin: boolean; moderator: boolean; bot: boolean; you: boolean };
  /** A remote person's home instance and when this copy was last refreshed; null for a local one. */
  home: { host: string; refreshedAt: string | null } | null;
  state: 'live' | 'deleted';
  /** The viewer blocks this person: directly, or through their instance. */
  blocked: 'actor' | 'instance' | null;
  /** Communities the viewer moderates where this person has live content, at most five. */
  moderatedCommunities: ActorRef[];
  /** False when the person opted out of search (their page carries `noindex`). */
  indexable: boolean;
};

export const moderatedCommunitiesMax = 5;

const namePattern = /^[\p{L}\p{N}_.-]{1,100}$/u;
const hostPattern = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** `name` (local) or `name@host`, with or without a leading `@`; null for anything else. */
function parseHandle(handle: string): { name: string; host: string | null } | null {
  const [name = '', host, ...rest] = (handle.startsWith('@') ? handle.slice(1) : handle).split('@');
  if (rest.length > 0 || !namePattern.test(name)) return null;
  if (host === undefined) return { name, host: null };
  return hostPattern.test(host.toLowerCase()) ? { name, host: host.toLowerCase() } : null;
}

/**
 * The public reference to an actor, field by field from an allowlist: the row it comes from may
 * be the whole actor row (user id, raw JSON, the auth role), and none of that may reach a page.
 */
export const publicActorRef = (actor: ActorRef): ActorRef => ({
  id: actor.id,
  apId: actor.apId,
  kind: actor.kind,
  name: actor.name,
  displayName: actor.displayName,
  local: actor.local,
  handle: actor.handle,
});

const refOf = (actor: Omit<ActorRef, 'handle'> & { domain: string }): ActorRef =>
  publicActorRef({ ...actor, handle: actor.local ? actor.name : `${actor.name}@${actor.domain}` });

/** Communities the viewer moderates where `personId` has a live post or comment. */
async function moderatedWith(q: Queryable, viewerId: Uuid, personId: Uuid): Promise<ActorRef[]> {
  const rows = await q
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      domain: instances.domain,
    })
    .from(communityModerators)
    .innerJoin(actors, eq(actors.id, communityModerators.communityId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(communityModerators.moderatorId, viewerId),
        freshModerator,
        isNull(actors.deletedAt),
        sql`(
          exists (select 1 from ${posts} where ${posts.communityId} = ${actors.id} and ${posts.authorId} = ${personId} and ${posts.deletedAt} is null and ${posts.removedAt} is null)
          or exists (
            select 1 from ${comments} join ${posts} as thread_post on thread_post.id = ${comments.postId}
            where thread_post.community_id = ${actors.id} and ${comments.authorId} = ${personId} and ${comments.deletedAt} is null and ${comments.removedAt} is null
          )
        )`,
      ),
    )
    .orderBy(actors.name)
    .limit(moderatedCommunitiesMax);
  return rows.map(refOf);
}

/**
 * The profile of a Person or a Service (a bot) by handle: `name` for a local one, `name@host`
 * for a remote one already stored here. Null for an unknown handle, a community or the
 * instance actor. A deleted account is still returned, as `state: 'deleted'`, with its
 * profile text withheld.
 */
export async function readProfile(handle: string, viewer: Viewer, q: Queryable = db()): Promise<Profile | null> {
  const parsed = parseHandle(handle);
  if (!parsed) return null;
  const found = await q
    .select({
      ...getTableColumns(actors),
      domain: instances.domain,
      role: authUser.role,
      twoFactor: authUser.twoFactorEnabled,
    })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .leftJoin(authUser, eq(authUser.id, actors.userId))
    .where(
      and(
        inArray(actors.kind, ['Person', 'Service']),
        sql`lower(${actors.name}) = ${parsed.name.toLowerCase()}`,
        parsed.host === null ? eq(instances.local, true) : eq(instances.domain, parsed.host),
      ),
    );
  const row = found.find((candidate) => candidate.name === parsed.name) ?? found[0];
  if (!row) return null;

  const deleted = row.deletedAt !== null;
  const isViewer = viewer?.actorId === row.id;
  const [[postCount], [commentCount], [moderates], blocked, moderated] = await Promise.all([
    q
      .select({ n: count() })
      .from(posts)
      .where(and(eq(posts.authorId, row.id), isNull(posts.deletedAt), isNull(posts.removedAt))),
    q
      .select({ n: count() })
      .from(comments)
      .where(and(eq(comments.authorId, row.id), isNull(comments.deletedAt), isNull(comments.removedAt))),
    q
      .select({ n: count() })
      .from(communityModerators)
      .where(and(eq(communityModerators.moderatorId, row.id), freshModerator)),
    viewer && !isViewer ? blockOf(q, viewer.actorId, row.id) : null,
    viewer && !isViewer && !deleted ? moderatedWith(q, viewer.actorId, row.id) : [],
  ]);
  const bio: PostBody | null = deleted
    ? null
    : row.summaryMd
      ? { kind: 'markdown', source: row.summaryMd }
      : row.summaryHtml
        ? { kind: 'html', html: row.summaryHtml, baseUrl: row.apId }
        : null;
  return {
    actor: refOf(row),
    iconUrl: deleted ? null : row.iconUrl,
    bio,
    joinedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    counts: deleted ? { posts: 0, comments: 0 } : { posts: postCount?.n ?? 0, comments: commentCount?.n ?? 0 },
    badges: {
      admin: row.role === 'admin' && row.twoFactor === true,
      moderator: (moderates?.n ?? 0) > 0,
      bot: row.bot || row.kind === 'Service',
      you: isViewer,
    },
    home: row.local ? null : { host: row.domain, refreshedAt: (row.fetchedAt ?? row.updatedAt)?.toISOString() ?? null },
    state: deleted ? 'deleted' : 'live',
    blocked,
    moderatedCommunities: moderated,
    indexable: row.indexable,
  };
}

/** A comment in the activity list: its own view and text, and where it was said. */
export type ProfileComment = { view: CommentView; body: PostBody | null; post: { id: Uuid; title: string }; community: ActorRef };
export type ProfileItem = { kind: 'post'; post: PostView } | { kind: 'comment'; comment: ProfileComment };

export type ActivityRequest = {
  personId: Uuid;
  tab: ProfileTab;
  sort: ProfileSort;
  /** The previous page's `next`; one that is not valid for this sort is ignored. */
  cursor?: string | undefined;
  limit?: number;
};

/** What orders an item and continues after it. */
type Key = { id: Uuid; pub: number; score: number };

const publishedMicros = (published: SQL) => sql<number>`(extract(epoch from ${published}) * 1000000)::float8`.mapWith(Number);
const microsToInstant = (micros: number) => sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`;

/** The rows of one list that come after the cursor in the sort's order, as SQL over that list's columns. */
function after(cursor: Cursor | null, sort: ProfileSort, c: { published: SQL; score: SQL; id: SQL }): SQL | undefined {
  if (!cursor) return undefined;
  if (sort === 'top') {
    if (cursor.score === undefined) return undefined;
    return sql`${c.score} <= ${cursor.score} and (${c.score}, ${c.id}) < (${cursor.score}, ${cursor.id}::uuid)`;
  }
  const at = microsToInstant(cursor.pub);
  return sql`${c.published} <= ${at} and (${c.published}, ${c.id}) < (${at}, ${cursor.id}::uuid)`;
}

const order = (sort: ProfileSort, c: { published: SQL; score: SQL; id: SQL }) =>
  sort === 'top' ? [sql`${c.score} desc`, sql`${c.id} desc`] : [sql`${c.published} desc nulls last`, sql`${c.id} desc`];

/** The query for the person's posts the viewer may see: the feed's conditions, scoped to the author. */
function postsQuery(q: Queryable, request: ActivityRequest, viewer: Viewer, cursor: Cursor | null, asOf: number, want: number) {
  const columns = { published: sql`${posts.publishedAt}`, score: sql`(${posts.upvotes} - ${posts.downvotes})`, id: sql`${posts.id}` };
  const conditions = visible('all', viewer, asOf, { authorId: request.personId });
  const next = after(cursor, request.sort, columns);
  if (next) conditions.push(next);
  return q
    .select({ ...getTableColumns(posts), pub: publishedMicros(sql`${posts.publishedAt}`) })
    .from(posts)
    .where(and(...conditions))
    .orderBy(...order(request.sort, columns))
    .limit(want);
}

async function postsPage(q: Queryable, request: ActivityRequest, viewer: Viewer, cursor: Cursor | null, asOf: number, want: number) {
  const rows = await postsQuery(q, request, viewer, cursor, asOf, want);
  const views = new Map((await postViews(rows, viewer, q)).map((view) => [view.id, view]));
  return rows.flatMap((row) => {
    const post = views.get(row.id);
    return post
      ? [{ key: { id: row.id, pub: row.pub, score: row.upvotes - row.downvotes }, item: { kind: 'post', post } as ProfileItem }]
      : [];
  });
}

/** The query for the person's live comments on posts the viewer may see. */
function commentsQuery(q: Queryable, request: ActivityRequest, viewer: Viewer, cursor: Cursor | null, asOf: number, want: number) {
  const columns = {
    published: sql`${comments.publishedAt}`,
    score: sql`(${comments.upvotes} - ${comments.downvotes})`,
    id: sql`${comments.id}`,
  };
  const conditions = [
    eq(comments.authorId, request.personId),
    isNull(comments.deletedAt),
    isNull(comments.removedAt),
    ...visible('all', viewer, asOf),
  ];
  const next = after(cursor, request.sort, columns);
  if (next) conditions.push(next);
  return q
    .select({
      id: comments.id,
      apId: comments.apId,
      postId: comments.postId,
      parentId: comments.parentId,
      path: comments.path,
      bodyMd: comments.bodyMd,
      contentHtml: comments.contentHtml,
      publishedAt: comments.publishedAt,
      editedAt: comments.editedAt,
      upvotes: comments.upvotes,
      downvotes: comments.downvotes,
      childCount: comments.childCount,
      postTitle: posts.title,
      communityId: posts.communityId,
      pub: publishedMicros(sql`${comments.publishedAt}`),
    })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .where(and(...conditions))
    .orderBy(...order(request.sort, columns))
    .limit(want);
}

async function commentsPage(q: Queryable, request: ActivityRequest, viewer: Viewer, cursor: Cursor | null, asOf: number, want: number) {
  const rows = await commentsQuery(q, request, viewer, cursor, asOf, want);
  if (rows.length === 0) return [];

  const [author, communities, mine] = await Promise.all([
    q
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
      .where(eq(actors.id, request.personId)),
    q
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
      .where(inArray(actors.id, [...new Set(rows.map((row) => row.communityId))])),
    viewer
      ? q
          .select({ commentId: votes.commentId, value: votes.value })
          .from(votes)
          .where(
            and(
              eq(votes.voterId, viewer.actorId),
              inArray(
                votes.commentId,
                rows.map((row) => row.id),
              ),
            ),
          )
      : [],
  ]);
  const person = author[0] ? refOf(author[0]) : null;
  if (!person) return [];
  const communityRefs = new Map(communities.map((row) => [row.id, refOf(row)]));
  const myVote = new Map(mine.flatMap(({ commentId, value }) => (commentId ? [[commentId, value === 1 ? 1 : -1] as const] : [])));
  return rows.flatMap((row) => {
    const community = communityRefs.get(row.communityId);
    if (!community) return [];
    const body: PostBody | null = row.bodyMd
      ? { kind: 'markdown', source: row.bodyMd }
      : row.contentHtml
        ? { kind: 'html', html: row.contentHtml, baseUrl: row.apId }
        : null;
    const view: CommentView = {
      id: row.id,
      apId: row.apId,
      postId: row.postId,
      parentId: row.parentId,
      depth: row.path.split('.').length - 1,
      contentHtml: null,
      author: person,
      authorBadge: null,
      publishedAt: row.publishedAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      deleted: false,
      removed: false,
      counts: { upvotes: row.upvotes, downvotes: row.downvotes, comments: row.childCount },
      myVote: myVote.get(row.id) ?? 0,
    };
    return [
      {
        key: { id: row.id, pub: row.pub, score: row.upvotes - row.downvotes } satisfies Key,
        item: { kind: 'comment', comment: { view, body, post: { id: row.postId, title: row.postTitle }, community } } as ProfileItem,
      },
    ];
  });
}

/**
 * The two queries a page of activity runs for its first page, for the performance test to
 * EXPLAIN the very statements.
 */
export function activityQueries(request: ActivityRequest, viewer: Viewer, q: Queryable = db()) {
  const want = Math.min(Math.max(Math.trunc(request.limit ?? defaultPageSize), 1), maxPageSize) + 1;
  return {
    posts: postsQuery(q, request, viewer, null, Date.now(), want),
    comments: commentsQuery(q, request, viewer, null, Date.now(), want),
  };
}

/**
 * One page of a person's activity for `viewer`: posts, comments, or both merged (Overview), by
 * date or score, keyset-paged with the feeds' cursor. The viewer's blocks apply as in a feed, so
 * a page of someone the viewer blocks is empty: the profile page does not ask for one. `next`
 * is null on the last page.
 */
export async function readActivity(request: ActivityRequest, viewer: Viewer, q: Queryable = db()): Promise<Page<ProfileItem>> {
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? defaultPageSize), 1), maxPageSize);
  const decoded = decodeCursor(request.cursor);
  const cursor = decoded && decoded.sort === request.sort ? decoded : null;
  const asOf = cursor?.asOf ?? Date.now();
  const want = limit + 1;
  const [fromPosts, fromComments] = await Promise.all([
    request.tab === 'comments' ? [] : postsPage(q, request, viewer, cursor, asOf, want),
    request.tab === 'posts' ? [] : commentsPage(q, request, viewer, cursor, asOf, want),
  ]);
  const newest = (a: { key: Key }, b: { key: Key }) =>
    (request.sort === 'top' ? b.key.score - a.key.score : b.key.pub - a.key.pub) || (b.key.id < a.key.id ? -1 : 1);
  const merged = [...fromPosts, ...fromComments].sort(newest);
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  const next =
    merged.length > limit && last
      ? encodeCursor({
          v: 1,
          sort: request.sort,
          period: 'all',
          asOf,
          pub: last.key.pub,
          id: last.key.id,
          ...(request.sort === 'top' ? { score: last.key.score } : {}),
        })
      : null;
  return { items: page.map(({ item }) => item), next };
}
