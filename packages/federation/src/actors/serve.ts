import type { Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { posts } from '@peblish/core/db/tables/content';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { create, page } from '../delivery/activities.ts';
import { loadCommentByApId, loadPost, loadPostByApId, localActorRecord, mentionTags, withTags } from '../delivery/records.ts';
import { toWire } from '../mapping/document.ts';
import type { Json, JsonObject } from '../mapping/json.ts';
import { LEMMY_CONTEXT } from '../mapping/vocabulary.ts';
import { communityRemovals } from '@peblish/core/moderation/tables';

// The documents a local actor, post, comment or activity is served as. Built with the same
// mapping peers receive in deliveries (toWire), so what they fetch is what they were sent. Fedify
// serves none of it: its dispatchers compact the JSON-LD and take one actor path (issue 646).

/** A document and the status it is served with: 410 carries a Tombstone. */
export type Served = { status: 200 | 410; json: JsonObject };

/** Items an outbox lists. Lemmy's lists every post; peers read the first page to backfill. */
export const outboxLimit = 20;

const AS = 'https://www.w3.org/ns/activitystreams';
const collectionName = /^(.*)\/(followers|outbox|featured|moderators)$/;
const objectPath = /^\/ap\/(post|comment|activity)\/([0-9a-f-]{36})$/;
const pagePath = /^\/([uc])\/([^/]+)$/;

type ActorRow = typeof actors.$inferSelect;

const withContext = (body: JsonObject): JsonObject => ({ '@context': LEMMY_CONTEXT, ...body });

async function actorByApId(db: Queryable, apId: string): Promise<ActorRow | null> {
  const [row] = await db
    .select()
    .from(actors)
    .where(and(eq(actors.apId, apId), eq(actors.local, true)));
  return row ?? null;
}

/**
 * The local actor a path names, or null. A path is the actor's stored ap_id, or the human page
 * of a Person (`/u/<name>`) or community (`/c/<name>`), which answers with the actor document
 * itself (PieFed's fetcher does not follow redirects). The page path is matched by name, so
 * `/u/alice` serves the actor whose id is `/ap/u.alice`.
 */
export async function localActorForPath(db: Queryable, origin: string, pathname: string): Promise<ActorRow | null> {
  const byId = await actorByApId(db, `${origin}${pathname}`);
  if (byId) return byId;
  const page = pagePath.exec(pathname);
  if (!page) return null;
  let name: string;
  try {
    name = decodeURIComponent(page[2]!);
  } catch {
    return null;
  }
  const [row] = await db
    .select()
    .from(actors)
    .where(
      and(
        eq(actors.local, true),
        eq(actors.kind, page[1] === 'u' ? 'Person' : 'Group'),
        sql`lower(${actors.name}) = ${name.toLowerCase()}`,
      ),
    );
  return row ?? null;
}

/** The document at `pathname` of this server, or null when nothing local is served there. */
export async function localDocument(db: Queryable, origin: string, pathname: string): Promise<Served | null> {
  const object = objectPath.exec(pathname);
  if (object) return objectDocument(db, origin, object[1] as 'post' | 'comment' | 'activity', `${origin}${pathname}`);
  const collection = collectionName.exec(pathname);
  if (collection) {
    // The instance actor's collections sit at the root: /outbox is the "" prefix of its id.
    const actor = await actorByApId(db, `${origin}${collection[1] || '/'}`);
    return actor ? collectionDocument(db, origin, actor, collection[2]!, `${origin}${pathname}`) : null;
  }
  const actor = await localActorForPath(db, origin, pathname);
  if (!actor) return null;
  return { status: 200, json: toWire({ kind: 'actor', actor: await localActorRecord(db, origin, actor) }) };
}

function tombstone(id: string, formerType: string, deleted: Date | null): Served {
  return {
    status: 410,
    json: { '@context': AS, type: 'Tombstone', id, formerType, ...(deleted && { deleted: deleted.toISOString() }) },
  };
}

/** The activity types that carry a post or comment; a Delete or an Undo only names it, so it outlives it. */
const contentActivities: ReadonlySet<string> = new Set(['Create', 'Update', 'Announce']);

/** The id of the Page or Note an activity carries, through Announce(Create(Page)) and the like; null when it carries none. */
function carriedContentId(activity: JsonObject): string | null {
  let node: Json | undefined = activity.object;
  while (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    if ((node.type === 'Page' || node.type === 'Note') && typeof node.id === 'string') return node.id;
    node = node.object;
  }
  return null;
}

/** Whether the local post or comment `apId` can still be served; true when it is not one of ours to judge. */
async function contentServable(db: Queryable, origin: string, apId: string): Promise<{ servable: boolean; deleted: Date | null }> {
  const post = await loadPostByApId(db, origin, apId);
  if (post) return { servable: post.servable, deleted: post.deletedAt };
  const comment = await loadCommentByApId(db, origin, apId);
  if (comment) return { servable: comment.servable, deleted: comment.deletedAt };
  return { servable: true, deleted: null };
}

async function objectDocument(db: Queryable, origin: string, kind: 'post' | 'comment' | 'activity', apId: string): Promise<Served | null> {
  if (kind === 'activity') {
    const [row] = await db
      .select({ type: activities.type, raw: activities.raw })
      .from(activities)
      .where(and(eq(activities.apId, apId), eq(activities.local, true)));
    if (!row) return null;
    const stored = row.raw as JsonObject;
    // What a Create, Update or Announce carried is gone: so is the activity, as far as peers can fetch it.
    const carried = contentActivities.has(row.type) ? carriedContentId(stored) : null;
    if (carried) {
      const content = await contentServable(db, origin, carried);
      if (!content.servable) return tombstone(apId, row.type, content.deleted);
    }
    return { status: 200, json: stored };
  }
  if (kind === 'post') {
    const loaded = await loadPostByApId(db, origin, apId);
    if (!loaded) return null;
    if (!loaded.servable) return tombstone(apId, 'Page', loaded.deletedAt);
    const tags = await mentionTags(db, origin, loaded.bodyMd);
    return { status: 200, json: withTags(toWire({ kind: 'post', post: loaded.record }), tags) };
  }
  const loaded = await loadCommentByApId(db, origin, apId);
  if (!loaded) return null;
  if (!loaded.servable) return tombstone(apId, 'Note', loaded.deletedAt);
  const tags = await mentionTags(db, origin, loaded.bodyMd);
  return { status: 200, json: withTags(toWire({ kind: 'comment', comment: loaded.record }), tags) };
}

/**
 * One of an actor's collections. Only the URLs the actor advertises are served, so a
 * community's `/followers` exists but a Person's `/featured` does not.
 */
async function collectionDocument(db: Queryable, origin: string, actor: ActorRow, name: string, url: string): Promise<Served | null> {
  const record = await localActorRecord(db, origin, actor);
  const advertised = {
    followers: record.followersUrl,
    outbox: record.outboxUrl,
    featured: record.featuredUrl,
    moderators: record.moderatorsUrl,
  }[name];
  if (advertised !== url) return null;
  const json = await (async (): Promise<JsonObject> => {
    switch (name) {
      case 'followers': {
        // Lemmy reads only the count; the people are not listed.
        const [row] = await db
          .select({ total: count() })
          .from(follows)
          .where(and(eq(follows.followeeId, actor.id), eq(follows.state, 'accepted')));
        return { type: 'Collection', id: url, totalItems: row?.total ?? 0, items: [] };
      }
      case 'moderators': {
        const rows = await db
          .select({ apId: actors.apId })
          .from(communityModerators)
          .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
          .where(and(eq(communityModerators.communityId, actor.id), isNull(actors.deletedAt)))
          .orderBy(desc(communityModerators.role), communityModerators.createdAt);
        return toWire({ kind: 'moderators', moderators: { apId: url, moderatorApIds: rows.map((row) => row.apId) } });
      }
      case 'featured':
        return { type: 'OrderedCollection', id: url, orderedItems: await pinnedPages(db, origin, actor) };
      default:
        return outboxCollection(db, origin, actor, url);
    }
  })();
  // toWire gives the moderators collection its @context; the rest get it here.
  return { status: 200, json: '@context' in json ? json : withContext(json) };
}

/** The community's pinned local posts as Pages, newest first (Lemmy lists the Pages themselves). */
async function pinnedPages(db: Queryable, origin: string, community: ActorRow): Promise<Json[]> {
  if (community.kind !== 'Group') return [];
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.communityId, community.id),
        eq(posts.local, true),
        eq(posts.featuredCommunity, true),
        isNull(posts.deletedAt),
        isNull(posts.removedAt),
      ),
    )
    .orderBy(desc(posts.publishedAt));
  const pages: Json[] = [];
  for (const { id } of rows) {
    const loaded = await loadPost(db, origin, id);
    if (!loaded?.servable) continue;
    const { '@context': _context, ...wire } = toWire({ kind: 'post', post: loaded.record });
    pages.push(withTags(wire, await mentionTags(db, origin, loaded.bodyMd)));
  }
  return pages;
}

/**
 * A community's outbox: a Create activity for each of its live local posts, newest first (Lemmy's
 * lists Create(Page) too), each rebuilt from the post as it is now under the id and author of
 * the Create we stored, so an edit shows and nothing deleted or removed lingers. Empty for a
 * community that is deleted or removed. A Person's or the instance actor's is empty; their
 * posts are read in their communities.
 */
async function outboxCollection(db: Queryable, origin: string, actor: ActorRow, url: string): Promise<JsonObject> {
  const empty: JsonObject = { type: 'OrderedCollection', id: url, totalItems: 0, orderedItems: [] };
  if (actor.kind !== 'Group' || actor.deletedAt) return empty;
  const [removal] = await db
    .select({ communityId: communityRemovals.communityId })
    .from(communityRemovals)
    .where(eq(communityRemovals.communityId, actor.id));
  if (removal) return empty;
  const live = and(
    eq(activities.type, 'Create'),
    eq(activities.local, true),
    eq(posts.communityId, actor.id),
    isNull(posts.deletedAt),
    isNull(posts.removedAt),
  );
  const [row] = await db.select({ total: count() }).from(activities).innerJoin(posts, eq(posts.apId, activities.objectApId)).where(live);
  const rows = await db
    .select({ id: activities.apId, actorApId: activities.actorApId, postId: posts.id })
    .from(activities)
    .innerJoin(posts, eq(posts.apId, activities.objectApId))
    .where(live)
    .orderBy(desc(activities.createdAt))
    .limit(outboxLimit);
  const items: Json[] = [];
  for (const { id, actorApId, postId } of rows) {
    const loaded = await loadPost(db, origin, postId);
    if (!loaded?.servable) continue;
    const activity = create({ id, actorApId, communityApId: loaded.community.apId }, page(loaded.record));
    const { '@context': _context, ...wire } = toWire({ kind: 'activity', activity });
    items.push(withTags(wire, await mentionTags(db, origin, loaded.bodyMd)));
  }
  return { type: 'OrderedCollection', id: url, totalItems: row?.total ?? 0, orderedItems: items };
}
