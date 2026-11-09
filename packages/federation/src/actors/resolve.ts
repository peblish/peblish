import { db } from '@peblish/core/db/read';
import { localInstance } from '@peblish/core/db/local-instance';
import { actors } from '@peblish/core/db/tables/actors';
import { checkRemoteActor, deleteRemoteActor, storeRemoteActor } from '@peblish/core/remote/actors';
import type { ActorKind } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actorFromWire } from '../mapping/actor.ts';
import { MappingError } from '../mapping/json.ts';
import { refreshInstanceSoftware } from '../nodeinfo/client.ts';
import { parseHandle, webfingerActorUrl, type Handle } from '../webfinger/client.ts';
import { FetchFailure, fetchActivity, type Fetcher } from './document.ts';
import { importGrant } from './grants.ts';
import { safeFetch } from './safe-fetch.ts';

// Finds an actor by id or handle, fetching and storing it when we do not hold a fresh copy.
// The network calls happen here, outside any transaction; storeRemoteActor is the one write.

export type ResolvedActor = {
  id: string;
  apId: string;
  /** The actor's preferredUsername. */
  name: string;
  kind: ActorKind;
  local: boolean;
  /** A remote actor that sent a Delete (or a local account that was deleted). */
  deleted: boolean;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
  instanceId: string;
};

/**
 * Why an actor could not be resolved. `unreachable` is the peer being down or slow (retry
 * later); every other reason is an answer or a document that will not change by asking again.
 */
export class ActorResolveError extends Error {
  override readonly name = 'ActorResolveError';
  readonly reason: 'blocked' | 'unreachable' | 'not_found' | 'gone' | 'invalid';

  constructor(reason: ActorResolveError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }

  get transient(): boolean {
    return this.reason === 'unreachable';
  }
}

export type ResolveOptions = {
  fetch?: Fetcher;
  /** Fetch even when the stored copy is fresh (a rotated key, an edited profile). */
  refresh?: boolean;
  /** How old a stored copy may be before it is fetched again; a day by default. */
  maxAgeMs?: number;
};

export const actorMaxAgeMs = 24 * 60 * 60 * 1000;

function failure(error: FetchFailure): ActorResolveError {
  const transient =
    error.reason === 'unreachable' || (error.status !== undefined && (error.status >= 500 || error.status === 429 || error.status === 408));
  if (transient) return new ActorResolveError('unreachable', error.message);
  if (error.reason === 'blocked' || error.reason === 'not_found' || error.reason === 'gone')
    return new ActorResolveError(error.reason, error.message);
  return new ActorResolveError('invalid', error.message);
}

async function stored(apId: string): Promise<(ResolvedActor & { fetchedAt: Date | null }) | null> {
  const [row] = await db()
    .select({
      id: actors.id,
      apId: actors.apId,
      name: actors.name,
      kind: actors.kind,
      local: actors.local,
      deletedAt: actors.deletedAt,
      inboxUrl: actors.inboxUrl,
      sharedInboxUrl: actors.sharedInboxUrl,
      instanceId: actors.instanceId,
      fetchedAt: actors.fetchedAt,
    })
    .from(actors)
    .where(eq(actors.apId, apId));
  if (!row) return null;
  const { deletedAt, ...rest } = row;
  return { ...rest, deleted: deletedAt !== null };
}

// Resolutions in flight, by actor id, so a burst of activities from one new actor fetches it
// once. (Another process racing is fine: the store's upsert ends with one row.) On globalThis
// because the web build can hold two copies of a module.
const running = ((globalThis as { __peblishActorResolves?: Map<string, Promise<ResolvedActor>> }).__peblishActorResolves ??= new Map());

/** An id without its fragment, as a comparable string. */
function withoutFragment(id: string): string {
  const url = new URL(id);
  url.hash = '';
  return url.href;
}

/**
 * storeRemoteActor's refusal of a kind change (core's RemoteActorKindError), matched by name so
 * this file does not depend on where that class is exported.
 */
function isKindError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'RemoteActorKindError';
}

/** Whether a fetched document is a Tombstone (`type` may be a list). */
function isTombstone(json: unknown): json is { id?: unknown } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  const { type } = json as { type?: unknown };
  return type === 'Tombstone' || (Array.isArray(type) && type.includes('Tombstone'));
}

async function fetchAndStore(apId: string, fetch: Fetcher): Promise<string> {
  const { json, url } = await fetchActivity(apId, fetch).catch((error: unknown) => {
    throw error instanceof FetchFailure ? failure(error) : error;
  });
  // Some servers answer a deleted account with a 200 Tombstone instead of a 410. It counts as a
  // 410 only when it names the address we asked for, or the one it was served from after a
  // redirect, and everything stays on the origin of the actor asked for: a Tombstone about
  // something else is some other document, and another origin cannot delete this actor.
  if (isTombstone(json)) {
    const named = typeof json.id === 'string' && URL.canParse(json.id) ? withoutFragment(json.id) : null;
    const origin = new URL(apId).origin;
    const bound =
      named !== null &&
      (named === withoutFragment(apId) || named === withoutFragment(url)) &&
      new URL(named).origin === origin &&
      new URL(url).origin === origin;
    if (!bound) throw new ActorResolveError('invalid', `${url} serves a Tombstone that does not name ${apId}`);
    throw new ActorResolveError('gone', `${url} serves a Tombstone for ${apId}`);
  }
  let record;
  try {
    record = actorFromWire(json);
  } catch (error) {
    if (error instanceof MappingError) throw new ActorResolveError('invalid', error.message);
    throw error;
  }
  // The document must be the one asked for: its id is the requested id, or the address it was
  // finally served from after a redirect (fragments aside). A same-origin /u/x serving the
  // actor /u/y is some other actor's document, not x.
  const claimed = withoutFragment(record.apId);
  if (claimed !== withoutFragment(apId) && claimed !== withoutFragment(url)) {
    throw new ActorResolveError('invalid', `${apId} serves the actor ${record.apId}, not the one asked for`);
  }
  // ...and it must come from the origin it names itself under.
  if (new URL(record.apId).origin !== new URL(url).origin) {
    throw new ActorResolveError('invalid', `${url} serves an actor of another origin, ${record.apId}`);
  }
  const problem = checkRemoteActor(record);
  if (problem) throw new ActorResolveError('invalid', problem);
  try {
    await storeRemoteActor(await importGrant('remote.actor_store', { apId: record.apId }), record);
  } catch (error) {
    // The document changed what kind of actor this id is (a Person that is now a Group): not an actor we can hold.
    if (isKindError(error)) throw new ActorResolveError('invalid', error.message);
    throw error;
  }
  await refreshInstanceSoftware(new URL(record.apId).origin, { fetch });
  return record.apId;
}

/**
 * A WebFinger answer is the host's claim about who a handle is; the actor's own document is what
 * settles it. The handle's name must be the actor's preferredUsername (case aside, as handles
 * are) and its sigil must be the actor's kind (@ a Person or a Service, a bot; ! a Group). The
 * actor may live on another host than the handle names, which split-domain setups (Mastodon's
 * WEB_DOMAIN) need.
 */
function checkHandle(handle: Handle, actor: Pick<ResolvedActor, 'name' | 'kind'>): void {
  if (actor.name.toLowerCase() !== handle.name.toLowerCase()) {
    throw new ActorResolveError('invalid', `${handle.name}@${handle.host} resolved to an actor named ${actor.name}`);
  }
  const sigilMatches = handle.kind === 'Person' ? actor.kind === 'Person' || actor.kind === 'Service' : actor.kind === handle.kind;
  if (handle.kind && !sigilMatches) {
    throw new ActorResolveError('invalid', `${handle.name}@${handle.host} names a ${handle.kind}, but the actor is a ${actor.kind}`);
  }
}

/**
 * The actor at `target`, an ap_id or a handle (@name@host, !name@host). Handles go through
 * WebFinger, and the actor found must be the one the handle names (checkHandle). A stored copy
 * fresher than `maxAgeMs` is returned without fetching the actor (its instance's NodeInfo is
 * read if that is missing or a day old); an older one is fetched again, and kept if the peer is
 * merely unreachable. A local actor is returned as stored. Throws ActorResolveError.
 */
export async function resolveRemoteActor(target: string, options: ResolveOptions = {}): Promise<ResolvedActor> {
  const fetch = options.fetch ?? safeFetch;
  const handle = parseHandle(target);
  let apId = target;
  if (handle) {
    try {
      apId = await webfingerActorUrl(handle, fetch);
    } catch (error) {
      throw error instanceof FetchFailure ? failure(error) : error;
    }
  }
  if (!URL.canParse(apId)) throw new ActorResolveError('invalid', `${target} is neither a URL nor a handle`);
  const resolved = await resolveId(apId, fetch, options);
  if (handle) checkHandle(handle, resolved);
  return resolved;
}

async function resolveId(apId: string, fetch: Fetcher, options: ResolveOptions): Promise<ResolvedActor> {
  const inflight = running.get(apId);
  if (inflight) return inflight;
  const work = (async () => {
    const held = await stored(apId);
    if (held?.local) return held;
    if ((await localInstance(db())).origin === new URL(apId).origin)
      throw new ActorResolveError('not_found', `${apId} is a local id with no actor`);
    const fresh = held?.fetchedAt && Date.now() - held.fetchedAt.getTime() < (options.maxAgeMs ?? actorMaxAgeMs);
    if (held && fresh && !options.refresh) {
      // A copy we hold may have been stored by a path that never read its instance's NodeInfo, or
      // when that read failed. The Announce shape for this actor's server hangs on it, so a
      // resolution is also a chance to read it (a read that is current, or failed lately, costs
      // one query).
      await refreshInstanceSoftware(new URL(held.apId).origin, { fetch });
      return held;
    }
    try {
      const storedId = await fetchAndStore(apId, fetch);
      const now = await stored(storedId);
      if (!now) throw new Error(`actor ${storedId} vanished after it was stored`);
      return now;
    } catch (error) {
      // A peer that is down does not make the copy we hold wrong.
      if (held && error instanceof ActorResolveError && error.transient) return held;
      // A 410 for an actor we hold is its server saying it is gone: delete our copy, as a refetch does (remote-fetch/actor.ts).
      if (held && !held.local && error instanceof ActorResolveError && error.reason === 'gone') {
        await deleteRemoteActor(await importGrant('remote.actor_delete', { apId }), { cause: 'Tombstone' });
      }
      throw error;
    }
  })().finally(() => running.delete(apId));
  running.set(apId, work);
  return work;
}
