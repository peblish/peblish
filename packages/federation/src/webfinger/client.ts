import { type } from 'arktype';
import { FetchFailure, fetchJson, type Fetcher } from '../actors/document.ts';

// Finds the actor URL behind a handle (@name@host for a person, !name@host for a community).

export type Handle = { name: string; host: string; kind: 'Person' | 'Group' | null };

/** `@name@host`, `!name@host`, `name@host` or `acct:name@host`; null for anything else. */
export function parseHandle(text: string): Handle | null {
  const match = /^(?:acct:)?([@!])?([\w.-]+)@([a-z0-9.-]+(?::\d{1,5})?)$/i.exec(text.trim());
  if (!match) return null;
  const sigil = match[1];
  return { name: match[2]!, host: match[3]!.toLowerCase(), kind: sigil === '!' ? 'Group' : sigil === '@' ? 'Person' : null };
}

const Jrd = type({
  links: type({
    rel: 'string',
    'type?': 'string',
    'href?': 'string.url',
    'properties?': 'Record<string, unknown>',
  }).array(),
});

const asType = 'https://www.w3.org/ns/activitystreams#type';
const activityType = /^application\/(activity\+json|ld\+json)/i;

/**
 * The actor URL a WebFinger answer names: the `self` link of an ActivityPub type. A name shared
 * by a person and a community (Lemmy allows it) lists both; the handle's sigil picks one.
 */
export function actorLink(json: unknown, kind: Handle['kind']): string | null {
  const jrd = Jrd(json);
  if (jrd instanceof type.errors) return null;
  const links = jrd.links.filter((link) => link.rel === 'self' && link.href && link.type && activityType.test(link.type));
  const preferred = kind ? links.find((link) => link.properties?.[asType] === kind) : undefined;
  return (preferred ?? links[0])?.href ?? null;
}

/** Asks the handle's host for its actor. Throws FetchFailure: the host's own answer, or `not_found` when no link names an actor. */
export async function webfingerActorUrl(handle: Handle, fetch: Fetcher): Promise<string> {
  const resource = `acct:${handle.name}@${handle.host}`;
  const url = `https://${handle.host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
  const { json } = await fetchJson(url, fetch, 'application/jrd+json, application/json');
  const href = actorLink(json, handle.kind);
  if (!href) throw new FetchFailure('not_found', `${resource} names no ActivityPub actor`);
  return href;
}
