import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { findHeld, pointsHere } from '@peblish/core/resolve/local';
import { resolveErrors, type Held, type Lookup, type ResolveError } from '@peblish/core/resolve/outcome';
import { eq } from 'drizzle-orm';
import { FetchFailure, fetchActivity, type Fetcher } from '../actors/document.ts';
import { ActorResolveError, resolveRemoteActor, type ResolvedActor } from '../actors/resolve.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { fromWire } from '../mapping/document.ts';
import { MappingError } from '../mapping/json.ts';
import { readObject, storeObject, type ObjectOutcome } from '../remote-fetch/object.ts';
import { limit, type Limited } from './limit.ts';

// Lane DISC's resolver, the one file web imports from federation (lint rule
// web-federation-entry-points). It finds a remote community, person, post or comment from a
// handle or a link, stores it through the stores the inbox uses, and says which local page now
// holds it. It runs in the web request that asked, on safeFetch, under one allowance of requests
// (limit.ts); the handler has already counted the lookup against the resolve budget.

export type ResolveResult = { ok: true; found: Held } | { ok: false; error: ResolveError };

/** A step's answer to the lookup, thrown to end it. */
class Stop extends Error {
  readonly code: ResolveError;

  constructor(code: ResolveError) {
    super(code);
    this.code = code;
  }
}

const known: ReadonlySet<string> = new Set(resolveErrors);

/** A peer's failure to serve a document, as the code the person sees. */
function fetchCode(error: FetchFailure): ResolveError {
  switch (error.reason) {
    case 'blocked':
      return 'input.invalid';
    case 'unreachable':
      return 'peer.unreachable';
    case 'not_found':
      return 'target.not_found';
    case 'gone':
      return 'target.gone';
    case 'status':
      return error.status !== undefined && (error.status >= 500 || error.status === 429 || error.status === 408)
        ? 'peer.unreachable'
        : 'peer.invalid';
    default:
      return 'peer.invalid';
  }
}

function actorCode(error: ActorResolveError): ResolveError {
  switch (error.reason) {
    case 'blocked':
      return 'input.invalid';
    case 'unreachable':
      return 'peer.unreachable';
    case 'invalid':
      return 'peer.invalid';
    default:
      return error.reason === 'gone' ? 'target.gone' : 'target.not_found';
  }
}

/** Why storing or reading an object ended without it: a refusal's reason as the code the person sees. */
function refusalCode(reason: string): ResolveError {
  switch (reason) {
    case 'community.removed':
    case 'community.deleted':
    case 'target.removed':
      return 'target.removed';
    case 'target.deleted':
      return 'target.gone';
    case 'object.local':
      return 'target.not_found';
    case 'object.blocked':
      return 'input.invalid';
    case 'object.not_found':
      return 'target.not_found';
    // The peer's documents do not hold together: an id that is not the address, an author off its origin, a post of another community.
    case 'object.status':
    case 'object.not_json':
    case 'object.too_large':
    case 'object.id_mismatch':
    case 'object.origin_mismatch':
    case 'object.author_mismatch':
    case 'community.mismatch':
      return 'peer.invalid';
  }
  if (known.has(reason)) return reason as ResolveError;
  console.warn(`resolve: an object was refused for a reason with no message of its own: ${reason}`);
  return 'generic';
}

function outcomeCode(outcome: ObjectOutcome): ResolveError {
  if (outcome.status === 'stored') return 'generic';
  if (outcome.status === 'gone') return 'target.gone';
  if (outcome.status === 'unreachable') return 'peer.unreachable';
  return refusalCode(outcome.reason);
}

const withActorError = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    throw error instanceof ActorResolveError ? new Stop(actorCode(error)) : error;
  }
};

/** The local page of an actor just resolved: a community or person, never one that is gone, removed or another kind. */
async function heldActor(actor: ResolvedActor): Promise<Held> {
  if (actor.deleted) throw new Stop('target.gone');
  if (actor.kind !== 'Group' && actor.kind !== 'Person' && actor.kind !== 'Service') throw new Stop('object.unsupported');
  // An actor that is stored but not held is a community an admin removed.
  const held = await findHeld({ kind: 'url', url: actor.apId });
  if (!held) throw new Stop('target.removed');
  return held;
}

async function byHandle(lookup: Extract<Lookup, { kind: 'handle' }>, fetch: Fetcher): Promise<Held> {
  const text = `${lookup.sigil ?? ''}${lookup.name}@${lookup.host}`;
  return heldActor(await withActorError(resolveRemoteActor(text, { fetch })));
}

const actorTypes: ReadonlySet<string> = new Set(['Person', 'Group', 'Service', 'Application']);
const objectTypes: ReadonlySet<string> = new Set(['Page', 'Note']);

/** The `type` (the first, when a list) and `id` a document says of itself. */
function identity(json: unknown): { type: string; id: string } | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const { type, id } = json as { type?: unknown; id?: unknown };
  const first = Array.isArray(type) ? type.find((entry): entry is string => typeof entry === 'string') : type;
  if (typeof first !== 'string' || typeof id !== 'string' || !URL.canParse(id) || new URL(id).protocol !== 'https:') return null;
  return { type: first, id };
}

async function byUrl(url: string, fetch: Fetcher): Promise<Held> {
  let document;
  try {
    document = await fetchActivity(url, fetch, { maxRedirects: 3 });
  } catch (error) {
    throw error instanceof FetchFailure ? new Stop(fetchCode(error)) : error;
  }
  // Only what the document says it is, and where it lives, is taken from this read: whatever it
  // claims is read again from its own address below, which holds it to its own origin.
  const said = identity(document.json);
  if (!said) throw new Stop('peer.invalid');
  // Some servers answer a deleted object with a 200 Tombstone instead of a 410.
  if (said.type === 'Tombstone') throw new Stop('target.gone');
  if (actorTypes.has(said.type)) return heldActor(await withActorError(resolveRemoteActor(said.id, { fetch })));
  if (!objectTypes.has(said.type)) throw new Stop('object.unsupported');
  return byObject(said.id, fetch);
}

/** A post or comment: read at its own id, vouched for by its community's own origin, stored as the inbox would. */
async function byObject(id: string, fetch: Fetcher): Promise<Held> {
  const read = await readObject(id, fetch);
  if (!('json' in read)) throw new Stop(outcomeCode(read));
  let mapped;
  try {
    mapped = fromWire(read.json);
  } catch (error) {
    throw error instanceof MappingError ? new Stop('object.unsupported') : error;
  }
  if ((mapped.kind !== 'post' && mapped.kind !== 'comment') || (mapped.kind === 'post' ? mapped.post : mapped.comment).apId !== id) {
    throw new Stop('object.unsupported');
  }
  const communityApId = (mapped.kind === 'post' ? mapped.post : mapped.comment).communityApId;
  if (communityApId === null) throw new Stop('object.unsupported');

  const community = await withActorError(resolveRemoteActor(communityApId, { fetch }));
  if (community.kind !== 'Group') throw new Stop('object.unsupported');
  if (community.deleted) throw new Stop('target.gone');
  const [flags] = await db().select({ sensitive: actors.sensitive, nsfl: actors.nsfl }).from(actors).where(eq(actors.id, community.id));
  if (!flags || flags.sensitive || flags.nsfl) throw new Stop('content.nsfw_rejected');
  // The author's claim of a community is not the community's word: the object must live where the community does.
  if (new URL(id).origin !== new URL(community.apId).origin) throw new Stop('object.unvouched');

  const outcome = await storeObject(
    read.json,
    { community: { id: community.id, apId: community.apId }, announceApId: id },
    { fetch, depth: 0 },
  );
  if (outcome.status !== 'stored') throw new Stop(outcomeCode(outcome));
  // Stored but not shown: the post, its community or the comment was removed or deleted.
  const held = await findHeld({ kind: 'url', url: id });
  if (!held) throw new Stop('target.removed');
  return held;
}

/**
 * Finds `lookup` on the network and stores it. A handle goes through WebFinger and the actor's
 * own document; a link is read once for what it is, then the community, person, post or comment
 * it names is read again at its own id. Never throws for a peer's misbehaviour: the answer is
 * the code to show. `fetch` is for tests (safeFetch by default).
 */
export async function resolveLookup(lookup: Lookup, { fetch = safeFetch }: { fetch?: Fetcher } = {}): Promise<ResolveResult> {
  // An address on this server that is not held is not there: no request for it.
  if (await pointsHere(lookup)) return { ok: false, error: 'target.not_found' };
  const guard: Limited = limit(fetch);
  try {
    return { ok: true, found: await (lookup.kind === 'handle' ? byHandle(lookup, guard.fetch) : byUrl(lookup.url, guard.fetch)) };
  } catch (error) {
    // The request allowance and a blocked host are why a fetcher failed, however it reports it.
    if (guard.spent) return { ok: false, error: 'resolve.too_large' };
    if (guard.blockedHost !== null) return { ok: false, error: 'instance.blocked' };
    if (error instanceof Stop) return { ok: false, error: error.code };
    console.error('resolve: unexpected failure', error);
    return { ok: false, error: 'generic' };
  }
}
