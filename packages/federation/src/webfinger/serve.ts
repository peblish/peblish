import type { Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { actorPagePath } from '@peblish/schema/actor-urls';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { localActorForPath } from '../actors/serve.ts';

// WebFinger (RFC 7033) for the local actors: `acct:<name>@<host>` for a Person or community
// (names are unique across both, so one name is one actor) and for the instance actor, whose
// name is the host. The links are Lemmy's: a profile page and a `self` link carrying the
// ActivityStreams type, which the first-contact resolution of Lemmy and PieFed reads.

export type Jrd = {
  subject: string;
  aliases: string[];
  links: { rel: string; type: string; href: string; properties?: Record<string, string> }[];
};

const activityStreamsType = 'https://www.w3.org/ns/activitystreams#type';
const profileRel = 'http://webfinger.net/rel/profile-page';

/** `acct:<name>@<host>` to the local actor with that name, or null (also for another host). */
async function actorForAccount(db: Queryable, origin: string, resource: string) {
  const match = /^acct:([^@]+)@(.+)$/i.exec(resource);
  if (!match || match[2]!.toLowerCase() !== new URL(origin).host) return null;
  const [row] = await db
    .select()
    .from(actors)
    .where(and(eq(actors.local, true), isNull(actors.deletedAt), sql`lower(${actors.name}) = ${match[1]!.toLowerCase()}`));
  return row ?? null;
}

/**
 * The JRD for `resource`: an `acct:` URI, or the https URL of an actor or its page on this
 * server. Null when it names no local actor (404); a deleted account no longer resolves.
 */
export async function webfingerFor(db: Queryable, origin: string, resource: string): Promise<Jrd | null> {
  const url = URL.canParse(resource) ? new URL(resource) : null;
  const actor =
    url?.protocol === 'acct:'
      ? await actorForAccount(db, origin, resource)
      : url?.origin === origin
        ? await localActorForPath(db, origin, url.pathname)
        : null;
  if (!actor || actor.deletedAt) return null;
  const { host } = new URL(origin);
  // The page of the instance actor is the home page; people and communities have /u/ and /c/.
  const profile =
    actor.kind === 'Application' ? null : `${origin}${actorPagePath(actor.kind === 'Group' ? 'Group' : 'Person', actor.name)}`;
  const links: Jrd['links'] = [];
  if (profile) links.push({ rel: profileRel, type: 'text/html', href: profile });
  links.push({
    rel: 'self',
    type: 'application/activity+json',
    href: actor.apId,
    properties: { [activityStreamsType]: actor.kind },
  });
  return {
    subject: `acct:${actor.name}@${host}`,
    aliases: [...new Set([profile, actor.apId].filter((alias): alias is string => alias !== null))],
    links,
  };
}

/** The WebFinger endpoint: `?resource=` is required and `?rel=` (repeatable) narrows the links. */
export async function serveWebFinger(db: Queryable, origin: string, url: URL): Promise<Response> {
  const resource = url.searchParams.get('resource');
  if (!resource) return new Response('resource is required', { status: 400 });
  const jrd = await webfingerFor(db, origin, resource);
  if (!jrd) return new Response('no such account', { status: 404, headers: { 'access-control-allow-origin': '*' } });
  const rels = url.searchParams.getAll('rel');
  const body = rels.length === 0 ? jrd : { ...jrd, links: jrd.links.filter((link) => rels.includes(link.rel)) };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/jrd+json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}
