import { deleteRemoteActor, undeleteRemoteActor } from '@peblish/core/remote/actors';
import type { Fetcher } from '../actors/document.ts';
import { importGrant } from '../actors/grants.ts';
import { ActorResolveError, resolveRemoteActor } from '../actors/resolve.ts';
import { safeFetch, type SafeResponse } from '../actors/safe-fetch.ts';
import { isTombstone } from './object.ts';

// Fetching an actor again on purpose, and acting on what the peer says: a 410 or a Tombstone
// is a deletion (the same one the actor's own Delete makes), and a valid document for an actor
// we hold as deleted brings it back. resolveRemoteActor (actors/resolve.ts) refreshes a stored
// actor on use after `remoteTtls.actorMs`; this is for a caller that wants to know the answer.

export type ActorRefresh =
  /** The document was fetched and stored. */
  | 'refreshed'
  /** 410 or a Tombstone: the actor is deleted here now (or already was). */
  | 'deleted'
  /** The actor was deleted here and its server serves a valid document again: alive, and stored. */
  | 'undeleted'
  /** The peer could not be reached; the copy we hold stands. */
  | 'unreachable'
  /** The answer was not a valid actor document, or the actor is one of ours. */
  | 'refused';

const tombstoneBody = (response: SafeResponse | undefined): boolean => {
  if (!response) return false;
  try {
    return isTombstone(JSON.parse(new TextDecoder().decode(response.body)));
  } catch {
    return false;
  }
};

/**
 * Fetches `apId` now, whatever the age of the stored copy, and stores what comes back.
 *
 * The actor GET is recorded, so the answer can be read twice: once to see whether a document
 * the store would not take (the actor is deleted here) was a valid one, and once more, replayed
 * from the record, for the store after the undelete. The peer is asked once.
 */
export async function refreshRemoteActor(apId: string, options: { fetch?: Fetcher } = {}): Promise<ActorRefresh> {
  const fetch = options.fetch ?? safeFetch;
  let recorded: SafeResponse | undefined;
  const recording: Fetcher = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url) === apId) recorded = response;
    return response;
  };
  const deletion = async (): Promise<ActorRefresh> => {
    await deleteRemoteActor(await importGrant('remote.actor_delete', { apId }), { cause: 'Tombstone' });
    return 'deleted';
  };
  try {
    const actor = await resolveRemoteActor(apId, { fetch: recording, refresh: true });
    if (actor.local) return 'refused';
    // Resolve keeps the copy it holds when the peer is down; a document was fetched only on a 200.
    if (recorded?.status !== 200) return 'unreachable';
    if (!actor.deleted) return 'refreshed';
    // Held as deleted, and the peer served a document that passed every check: the store only declined it.
    await undeleteRemoteActor(await importGrant('remote.actor_undelete', { apId }));
    const replay: Fetcher = (url, init) => (String(url) === apId && recorded ? Promise.resolve(recorded) : fetch(url, init));
    return (await resolveRemoteActor(apId, { fetch: replay, refresh: true })).deleted ? 'refused' : 'undeleted';
  } catch (error) {
    if (!(error instanceof ActorResolveError)) throw error;
    if (error.reason === 'gone' || (error.reason === 'invalid' && tombstoneBody(recorded))) return deletion();
    return error.transient ? 'unreachable' : 'refused';
  }
}
