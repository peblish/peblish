import type { Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { posts } from '@peblish/core/db/tables/content';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { loadCommentByApId, loadPost, loadPostByApId, localActorRecord, mentionTags, withTags } from '../delivery/records.ts';
import { toWire } from '../mapping/document.ts';
import type { Json, JsonObject } from '../mapping/json.ts';
import { LEMMY_CONTEXT } from '../mapping/vocabulary.ts';

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

async function objectDocument(db: Queryable, origin: string, kind: 'post' | 'comment' | 'activity', apId: string): Promise<Served | null> {
  if (kind === 'activity') {
    const [row] = await db
      .select({ raw: activities.raw })
      .from(activities)
      .where(and(eq(activities.apId, apId), eq(activities.local, true)));
    return row ? { status: 200, json: row.raw as JsonObject } : null;
  }
  if (kind === 'post') {
    const loaded = await loadPostByApId(db, origin, apId);
    if (!loaded) return null;
    if (!loaded.live) return tombstone(apId, 'Page', loaded.deletedAt);
    const tags = await mentionTags(db, origin, loaded.bodyMd);
    return { status: 200, json: withTags(toWire({ kind: 'post', post: loaded.record }), tags) };
  }
  const loaded = await loadCommentByApId(db, origin, apId);
  if (!loaded) return null;
  if (!loaded.live) return tombstone(apId, 'Note', loaded.deletedAt);
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
        return outboxCollection(db, actor, url);
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
    if (!loaded) continue;
    const { '@context': _context, ...page } = toWire({ kind: 'post', post: loaded.record });
    pages.push(withTags(page, await mentionTags(db, origin, loaded.bodyMd)));
  }
  return pages;
}

/**
 * A community's outbox: the Create activities we stored for its live local posts, newest
 * first (Lemmy's lists Create(Page) too). A Person's or the instance actor's is empty; their
 * posts are read in their communities.
 */
async function outboxCollection(db: Queryable, actor: ActorRow, url: string): Promise<JsonObject> {
  if (actor.kind !== 'Group') return { type: 'OrderedCollection', id: url, totalItems: 0, orderedItems: [] };
  const live = and(
    eq(activities.type, 'Create'),
    eq(activities.local, true),
    eq(posts.communityId, actor.id),
    isNull(posts.deletedAt),
    isNull(posts.removedAt),
  );
  const [row] = await db.select({ total: count() }).from(activities).innerJoin(posts, eq(posts.apId, activities.objectApId)).where(live);
  const rows = await db
    .select({ raw: activities.raw })
    .from(activities)
    .innerJoin(posts, eq(posts.apId, activities.objectApId))
    .where(live)
    .orderBy(desc(activities.createdAt))
    .limit(outboxLimit);
  const items = rows.map(({ raw }) => {
    const { '@context': _context, ...activity } = raw as JsonObject;
    return activity;
  });
  return { type: 'OrderedCollection', id: url, totalItems: row?.total ?? 0, orderedItems: items };
}
