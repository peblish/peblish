import { Uuid } from '@peblish/schema/ids';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { actorRef } from '../directory/ref.ts';
import { localInstance } from '../db/local-instance.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityRemovals } from '../moderation/tables.ts';
import type { Held, Lookup } from './outcome.ts';

// What this server already holds for a lookup, from the database alone: no request is made
// here. A hit is the local page to send the person to; a miss is the resolver's job (or, for
// an address on this server, a plain not found).

const notRemoved = sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`;

const actorColumns = {
  id: actors.id,
  apId: actors.apId,
  kind: actors.kind,
  name: actors.name,
  displayName: actors.displayName,
  local: actors.local,
  host: instances.domain,
};

/** The host this server answers to, as handles write it. */
async function localHost(q: Queryable): Promise<{ host: string; origin: string }> {
  const { origin } = await localInstance(q);
  return { host: new URL(origin).host, origin };
}

/** Whether the lookup names this server (its host or an address on its origin), held or not. */
export async function pointsHere(lookup: Lookup, q: Queryable = readDb()): Promise<boolean> {
  const here = await localHost(q);
  return lookup.kind === 'handle' ? lookup.host === here.host : new URL(lookup.url).origin === here.origin;
}

/** A live actor by handle on `host`, of the kind the sigil names (none: a community first). */
async function actorByHandle(
  q: Queryable,
  { sigil, name, host }: { sigil: '!' | '@' | null; name: string; host: string },
  isLocalHost: boolean,
): Promise<Held | null> {
  const kinds =
    sigil === '!' ? (['Group'] as const) : sigil === '@' ? (['Person', 'Service'] as const) : (['Group', 'Person', 'Service'] as const);
  const [row] = await q
    .select(actorColumns)
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        isLocalHost ? eq(actors.local, true) : and(eq(actors.local, false), eq(instances.domain, host)),
        sql`lower(${actors.name}) = ${name.toLowerCase()}`,
        inArray(actors.kind, [...kinds]),
        isNull(actors.deletedAt),
        notRemoved,
      ),
    )
    // A name shared by a community and a person (Lemmy allows it) answers the community unless the sigil says otherwise.
    .orderBy(desc(sql`${actors.kind} = 'Group'`))
    .limit(1);
  return row ? heldActor(row) : null;
}

function heldActor(row: Parameters<typeof actorRef>[0]): Held | null {
  if (row.kind === 'Group') return { kind: 'community', actor: actorRef(row) };
  if (row.kind === 'Person' || row.kind === 'Service') return { kind: 'person', actor: actorRef(row) };
  return null;
}

/** Candidate ids for a pasted address: as given and without a trailing slash, never a fragment. */
function candidates(url: URL): string[] {
  const bare = new URL(url.href);
  bare.hash = '';
  const withSlash = bare.href;
  return withSlash.endsWith('/') && bare.pathname !== '/' ? [withSlash, withSlash.slice(0, -1)] : [withSlash];
}

/** A post that can be shown: not deleted or removed, in a community that is not deleted or removed. */
async function livePost(q: Queryable, where: ReturnType<typeof eq>): Promise<Held | null> {
  const [row] = await q
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(actors, eq(actors.id, posts.communityId))
    .where(and(where, isNull(posts.deletedAt), isNull(posts.removedAt), isNull(actors.deletedAt), notRemoved));
  return row ? { kind: 'post', postId: row.id } : null;
}

async function liveComment(q: Queryable, where: ReturnType<typeof eq>): Promise<Held | null> {
  const [row] = await q
    .select({ id: comments.id, postId: comments.postId })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .innerJoin(actors, eq(actors.id, posts.communityId))
    .where(
      and(
        where,
        isNull(comments.deletedAt),
        isNull(comments.removedAt),
        isNull(posts.deletedAt),
        isNull(posts.removedAt),
        isNull(actors.deletedAt),
        notRemoved,
      ),
    );
  return row ? { kind: 'comment', postId: row.postId, commentId: row.id } : null;
}

const segment = (text: string | undefined): string | null => {
  if (!text) return null;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** One of this server's own page paths: /c/<name>, /u/<name>, /post/<uuid>[/comments/<uuid>]. */
async function ownPath(q: Queryable, url: URL, host: string): Promise<Held | null> {
  const [, area, first, middle, second, ...rest] = url.pathname.split('/');
  if (rest.length > 0) return null;
  if ((area === 'c' || area === 'u') && first && middle === undefined) {
    const name = segment(first);
    if (name === null) return null;
    const sigil = area === 'c' ? '!' : '@';
    // /c/<name>@<host> is how this server writes a remote community's page.
    const at = name.lastIndexOf('@');
    if (at > 0)
      return actorByHandle(
        q,
        { sigil, name: name.slice(0, at), host: name.slice(at + 1).toLowerCase() },
        name.slice(at + 1).toLowerCase() === host,
      );
    return actorByHandle(q, { sigil, name, host }, true);
  }
  if (area === 'post' && Uuid.allows(first)) {
    if (middle === undefined) return livePost(q, eq(posts.id, first));
    if (middle === 'comments' && Uuid.allows(second)) return liveComment(q, and(eq(comments.id, second), eq(comments.postId, first))!);
  }
  return null;
}

/**
 * The community, person, post or comment this server already holds for `lookup`, or null. A
 * handle is matched on its host and name (case aside) with the sigil choosing the kind; a link by
 * its ActivityPub id or as one of this server's own page paths. Deleted and removed things are
 * not held (a page for them would be a tombstone or a 404, not an answer to a lookup).
 */
export async function findHeld(lookup: Lookup, q: Queryable = readDb()): Promise<Held | null> {
  const here = await localHost(q);
  if (lookup.kind === 'handle') return actorByHandle(q, lookup, lookup.host === here.host);
  const url = new URL(lookup.url);
  const ids = candidates(url);
  const [actor] = await q
    .select(actorColumns)
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(and(inArray(actors.apId, ids), isNull(actors.deletedAt), notRemoved));
  const asActor = actor ? heldActor(actor) : null;
  if (asActor) return asActor;
  const post = await livePost(q, inArray(posts.apId, ids));
  if (post) return post;
  const comment = await liveComment(q, inArray(comments.apId, ids));
  if (comment) return comment;
  return url.origin === here.origin ? ownPath(q, url, here.host) : null;
}
