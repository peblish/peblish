import type { Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { authSession } from '@peblish/core/db/tables/auth';
import { comments, posts } from '@peblish/core/db/tables/content';
import { and, count, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { software } from '../federation.ts';

// NodeInfo 2.1 and 2.0 for this server and the discovery document that points at them. The
// fields are the ones Lemmy and PieFed read: software name, usage (PieFed marks an instance
// dormant without recent activity, Lemmy dead) and the node name, which equals the instance
// actor's name.

const schemas = {
  '2.0': 'http://nodeinfo.diaspora.software/ns/schema/2.0',
  '2.1': 'http://nodeinfo.diaspora.software/ns/schema/2.1',
} as const;
export type NodeInfoVersion = keyof typeof schemas;

const day = 24 * 60 * 60 * 1000;

/** Active local people: a session used, a post or a comment written, since `since`. */
async function activeSince(db: Queryable, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(actors)
    .where(
      and(
        eq(actors.local, true),
        eq(actors.kind, 'Person'),
        isNotNull(actors.userId),
        isNull(actors.deletedAt),
        or(
          sql`exists (select 1 from ${authSession} where ${authSession.userId} = ${actors.userId} and ${authSession.updatedAt} > ${since.toISOString()})`,
          sql`exists (select 1 from ${posts} where ${posts.authorId} = ${actors.id} and ${posts.publishedAt} > ${since.toISOString()})`,
          sql`exists (select 1 from ${comments} where ${comments.authorId} = ${actors.id} and ${comments.publishedAt} > ${since.toISOString()})`,
        ),
      ),
    );
  return row?.n ?? 0;
}

/** The NodeInfo document of `version`. Counts are live; the caller caches them. */
export async function nodeInfo(db: Queryable, version: NodeInfoVersion, now = new Date()) {
  const [users, posts_, comments_, instanceActor, activeMonth, activeHalfyear] = await Promise.all([
    db
      .select({ n: count() })
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Person'), isNotNull(actors.userId), isNull(actors.deletedAt))),
    db
      .select({ n: count() })
      .from(posts)
      .where(and(eq(posts.local, true), isNull(posts.deletedAt), isNull(posts.removedAt))),
    db
      .select({ n: count() })
      .from(comments)
      .where(and(eq(comments.local, true), isNull(comments.deletedAt), isNull(comments.removedAt))),
    db
      .select({ name: actors.name, displayName: actors.displayName })
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Application'))),
    activeSince(db, new Date(now.getTime() - 30 * day)),
    activeSince(db, new Date(now.getTime() - 182 * day)),
  ]);
  const site = instanceActor[0];
  return {
    version,
    software:
      version === '2.1'
        ? { name: software.name, version: software.version, repository: software.repository }
        : { name: software.name, version: software.version },
    protocols: ['activitypub'],
    services: { inbound: [], outbound: [] },
    // The beta registers people by invitation only.
    openRegistrations: false,
    usage: {
      users: { total: users[0]?.n ?? 0, activeMonth, activeHalfyear },
      localPosts: posts_[0]?.n ?? 0,
      localComments: comments_[0]?.n ?? 0,
    },
    // The instance actor's name is the host; Lemmy and PieFed show the node name beside it.
    metadata: { nodeName: site?.displayName ?? site?.name ?? '' },
  };
}

/** Where NodeInfo documents live, for /.well-known/nodeinfo. */
export function nodeInfoDiscovery(origin: string) {
  return { links: Object.entries(schemas).map(([version, rel]) => ({ rel, href: `${origin}/nodeinfo/${version}` })) };
}

const cache = globalThis as { __peblishNodeInfo?: Map<string, { at: number; body: string }> };
const maxAgeMs = 60_000;

/** /.well-known/nodeinfo and /nodeinfo/<version>; the counts are cached for a minute. */
export async function serveNodeInfo(db: Queryable, origin: string, pathname: string): Promise<Response> {
  const headers = { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' };
  if (pathname === '/.well-known/nodeinfo') {
    return new Response(JSON.stringify(nodeInfoDiscovery(origin)), {
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const version = /^\/nodeinfo\/(2\.[01])$/.exec(pathname)?.[1] as NodeInfoVersion | undefined;
  if (!version) return new Response('no such NodeInfo version', { status: 404 });
  const entries = (cache.__peblishNodeInfo ??= new Map());
  let entry = entries.get(version);
  if (!entry || Date.now() - entry.at > maxAgeMs) {
    entry = { at: Date.now(), body: JSON.stringify(await nodeInfo(db, version)) };
    entries.set(version, entry);
  }
  return new Response(entry.body, {
    headers: { ...headers, 'content-type': `application/json; profile="${schemas[version]}#"` },
  });
}

/** Forgets the cached documents (tests that change the counts). */
export function resetNodeInfoCache(): void {
  cache.__peblishNodeInfo?.clear();
}
