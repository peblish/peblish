import { Uuid } from '@peblish/schema/ids';
import { excerptLength } from '@peblish/schema/markdown';
import type { ActorRef, AuthorBadge, PostView } from '@peblish/schema/views';
import { and, eq, inArray } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { hideNsfw, showNsfw, shows, type NsfwChoice } from '../communities/gate.ts';
import { db, type Queryable } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { posts, votes } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { renderMarkdown } from '../markdown/render.ts';
import { sanitizeRemoteHtml } from '../markdown/sanitize.ts';
import { communityRemovals } from '../moderation/tables.ts';

// The read model of a post: the row to PostView mapping that feeds reuse (postViews) and the
// post page's data (readPost). It decides what a viewer may see, in one place, so no caller can
// forget a gate: a deleted post is a tombstone, a removed one shows only that to everyone but
// the community's moderators and site admins, and a sensitive or NSFL post reaches a viewer
// without its title, link, preview or body unless they declared 16+ and chose to show NSFW
// (Hide NSFW is on by default; the choice is the browser's, see communities/gate.ts).
// Withheld fields are '' or null; the flags (deleted, removed, sensitive, nsfl) stay true.
// A post in a deleted or removed community is not shown at all: postViews leaves it out and
// readPost answers null, for every viewer.

/** Who is looking: a signed-in person (their id and site role), or null when signed out. */
export type Viewer = { actorId: Uuid; siteRole: 'user' | 'admin' } | null;

export type PostRow = typeof posts.$inferSelect;

/** What to render for the body: the web renderer takes Markdown through render, remote HTML through sanitize. */
export type PostBody = { kind: 'markdown'; source: string } | { kind: 'html'; html: string; baseUrl: string };

/**
 * Where the sensitive-content gate stands for this viewer: none (the post is not sensitive, or
 * the viewer declared 16+ and chose to show it), sign-in (signed out), age (signed in without a
 * 16+ declaration) or hidden (declared, Hide NSFW on). Every gate but none withholds the content.
 */
export type Gate = 'none' | 'sign-in' | 'age' | 'hidden';

export type PostPage = {
  view: PostView;
  /** Null when the post has no body or the view withholds it. */
  body: PostBody | null;
  gate: Gate;
  /** The viewer is a site admin or a moderator or owner of the post's community. */
  moderator: boolean;
};

/** Characters of body source that a card excerpt reads; the excerpt itself is excerptLength. */
const excerptSourceLength = 2_000;
const excerptHtmlLength = 20_000;

type Known = ActorRef & { sensitive: boolean; nsfl: boolean };

type Context = {
  origin: string;
  viewer: Viewer;
  declared: boolean;
  /** Communities that are deleted or removed by an admin: nothing in them is shown. */
  closed: Set<Uuid>;
  known: Map<Uuid, Known>;
  admins: Set<Uuid>;
  moderators: Set<string>;
  moderated: Set<Uuid>;
  mine: Map<Uuid, 1 | -1>;
};

const pair = (communityId: Uuid, actorId: Uuid) => `${communityId}:${actorId}`;

async function load(q: Queryable, rows: readonly PostRow[], viewer: Viewer): Promise<Context> {
  const authorIds = [...new Set(rows.map((row) => row.authorId))];
  const communityIds = [...new Set(rows.map((row) => row.communityId))];
  const postIds = rows.map((row) => row.id);
  const empty = rows.length === 0;
  const [instance, people, removals, admins, moderators, mine, declaration, viewerRoles] = await Promise.all([
    localInstance(q),
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
            sensitive: actors.sensitive,
            nsfl: actors.nsfl,
            deletedAt: actors.deletedAt,
            domain: instances.domain,
          })
          .from(actors)
          .innerJoin(instances, eq(instances.id, actors.instanceId))
          .where(inArray(actors.id, [...authorIds, ...communityIds])),
    empty
      ? []
      : q
          .select({ communityId: communityRemovals.communityId })
          .from(communityRemovals)
          .where(inArray(communityRemovals.communityId, communityIds)),
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
          .select({ communityId: communityModerators.communityId, moderatorId: communityModerators.moderatorId })
          .from(communityModerators)
          .where(
            and(
              inArray(communityModerators.moderatorId, authorIds),
              inArray(communityModerators.communityId, communityIds),
              freshModerator,
            ),
          ),
    viewer && !empty
      ? q
          .select({ postId: votes.postId, value: votes.value })
          .from(votes)
          .where(and(eq(votes.voterId, viewer.actorId), inArray(votes.postId, postIds)))
      : [],
    viewer ? q.select({ actorId: ageDeclarations.actorId }).from(ageDeclarations).where(eq(ageDeclarations.actorId, viewer.actorId)) : [],
    viewer && !empty && viewer.siteRole !== 'admin'
      ? q
          .select({ communityId: communityModerators.communityId })
          .from(communityModerators)
          .where(
            and(
              eq(communityModerators.moderatorId, viewer.actorId),
              inArray(communityModerators.communityId, communityIds),
              freshModerator,
            ),
          )
      : [],
  ]);
  return {
    origin: instance.origin,
    viewer,
    declared: declaration.length > 0,
    closed: new Set([
      ...removals.map(({ communityId }) => communityId),
      ...people.filter(({ id, deletedAt }) => deletedAt && communityIds.includes(id)).map(({ id }) => id),
    ]),
    known: new Map(
      people.map(({ domain, sensitive, nsfl, deletedAt: _deletedAt, ...actor }) => [
        actor.id,
        { ...actor, handle: actor.local ? actor.name : `${actor.name}@${domain}`, sensitive, nsfl },
      ]),
    ),
    admins: new Set(admins.map(({ id }) => id)),
    moderators: new Set(moderators.map(({ communityId, moderatorId }) => pair(communityId, moderatorId))),
    moderated: viewer?.siteRole === 'admin' ? new Set(communityIds) : new Set(viewerRoles.map(({ communityId }) => communityId)),
    mine: new Map(mine.flatMap(({ postId, value }) => (postId ? [[postId, value === 1 ? 1 : -1] as const] : []))),
  };
}

const actorRef = ({ sensitive: _sensitive, nsfl: _nsfl, ...ref }: Known): ActorRef => ref;

/** Plain text for a card, from the start of the body only: the cost stays flat for a long post. */
function excerptOf(row: PostRow, origin: string): string | null {
  const text = row.bodyMd
    ? renderMarkdown(row.bodyMd.slice(0, excerptSourceLength), { baseOrigin: origin, excerptLength }).excerpt
    : row.contentHtml
      ? sanitizeRemoteHtml(row.contentHtml.slice(0, excerptHtmlLength), { baseUrl: row.apId, excerptLength }).excerpt
      : '';
  return text || null;
}

function describe(row: PostRow, c: Context, nsfw: NsfwChoice): PostPage {
  const author = c.known.get(row.authorId);
  const community = c.known.get(row.communityId);
  if (!author || !community) throw new Error(`post ${row.id} names an actor that is gone`);
  const moderator = c.moderated.has(row.communityId);
  const flagged = row.sensitive || row.nsfl || community.sensitive || community.nsfl;
  const gate: Gate = !flagged ? 'none' : !c.viewer ? 'sign-in' : !c.declared ? 'age' : shows(nsfw, row.communityId) ? 'none' : 'hidden';
  const removedForViewer = row.removedAt !== null && !moderator;
  const show = row.deletedAt === null && !removedForViewer && gate === 'none';
  const body: PostBody | null = !show
    ? null
    : row.bodyMd
      ? { kind: 'markdown', source: row.bodyMd }
      : row.contentHtml
        ? { kind: 'html', html: row.contentHtml, baseUrl: row.apId }
        : null;
  const badge: AuthorBadge = c.admins.has(author.id) ? 'admin' : c.moderators.has(pair(community.id, author.id)) ? 'moderator' : null;
  return {
    view: {
      id: row.id,
      apId: row.apId,
      title: show ? row.title : '',
      url: show ? row.url : null,
      urlContentType: show ? row.urlContentType : null,
      thumbnailUrl: show ? row.thumbnailUrl : null,
      contentHtml: null,
      excerpt: show ? excerptOf(row, c.origin) : null,
      author: actorRef(author),
      authorBadge: badge,
      community: actorRef(community),
      publishedAt: row.publishedAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      sensitive: row.sensitive || community.sensitive,
      nsfl: row.nsfl || community.nsfl,
      locked: row.locked,
      featured: row.featuredCommunity,
      deleted: row.deletedAt !== null,
      removed: row.removedAt !== null,
      counts: { upvotes: row.upvotes, downvotes: row.downvotes, comments: row.commentCount },
      myVote: c.mine.get(row.id) ?? 0,
    },
    body,
    gate,
    moderator,
  };
}

/**
 * Posts as views, in the order given, for a feed or a profile (lane C1 queries the rows and
 * keeps its own order and filters). A few queries per page, none per row. contentHtml stays
 * null: feeds show `excerpt`, and the post page renders the body from readPost. A post in a
 * deleted or removed community is left out for every viewer, so the result can be shorter than
 * `rows`: match by `view.id`, not by position (a feed query that joins the community keeps its
 * pages full).
 */
export async function postViews(rows: readonly PostRow[], viewer: Viewer, q: Queryable = db()): Promise<PostView[]> {
  const context = await load(q, rows, viewer);
  return rows.filter((row) => !context.closed.has(row.communityId)).map((row) => describe(row, context, showNsfw).view);
}

/**
 * One post for its page; null when there is none, the id is not a uuid, or the post's community
 * is deleted or removed. A deleted post is a tombstone (view.deleted, content withheld) and a
 * removed one is withheld from all but moderators; the page answers 200 for both and still
 * lists the comments. `nsfw` is the browser's Hide NSFW choice (default: hide); a page passes
 * the one its cookies carry.
 */
export async function readPost(id: string, viewer: Viewer, q: Queryable = db(), nsfw: NsfwChoice = hideNsfw): Promise<PostPage | null> {
  if (!Uuid.allows(id)) return null;
  const [row] = await q.select().from(posts).where(eq(posts.id, id));
  if (!row) return null;
  const context = await load(q, [row], viewer);
  return context.closed.has(row.communityId) ? null : describe(row, context, nsfw);
}
