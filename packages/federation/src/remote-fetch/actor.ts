import { deleteRemoteActor, undeleteRemoteActor } from '@peblish/core/remote/actors';
import type { Fetcher } from '../actors/document.ts';
import { importGrant } from '../actors/grants.ts';
import { ActorResolveError, resolveRemoteActor } from '../actors/resolve.ts';
import { safeFetch, type SafeResponse } from '../actors/safe-fetch.ts';

// Fetching an actor again on purpose, and acting on what the peer says: a 410 or a Tombstone
// is a deletion, and a valid document for an actor we hold as deleted because of a 410 or a
// Tombstone brings it back. An actor that sent a signed Delete stays deleted whatever the peer
// serves now (a cached or older document would otherwise bring it back); only its own Undo
// restores it (inbound/handlers/delete.ts). resolveRemoteActor (actors/resolve.ts) refreshes a stored
// actor on use after `remoteTtls.actorMs`; this is for a caller that wants to know the answer.

export type ActorRefresh =
  /** The document was fetched and stored. */
  | 'refreshed'
  /** 410 or a Tombstone, or its own signed Delete stands: the actor is deleted here now (or already was). */
  | 'deleted'
  /** The actor was deleted here and its server serves a valid document again: alive, and stored. */
  | 'undeleted'
  /** The peer could not be reached; the copy we hold stands. */
  | 'unreachable'
  /** The answer was not a valid actor document, or the actor is one of ours. */
  | 'refused';

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
    // Held as deleted, and the peer served a document that passed every check: the store only
    // declined it. A deletion that came from a 410 or a Tombstone is taken back, but one the actor
    // made with its own signed Delete stands until its own Undo (the mutation checks the ledger
    // under the actor's row lock, so a Delete that arrives meanwhile wins).
    const back = await undeleteRemoteActor(await importGrant('remote.actor_undelete', { apId }), { via: 'refresh' });
    if (back.signedDelete) return 'deleted';
    if (!back.undeleted) return 'refreshed';
    const replay: Fetcher = (url, init) => (String(url) === apId && recorded ? Promise.resolve(recorded) : fetch(url, init));
    return (await resolveRemoteActor(apId, { fetch: replay, refresh: true })).deleted ? 'refused' : 'undeleted';
  } catch (error) {
    if (!(error instanceof ActorResolveError)) throw error;
    // The resolver turns a Tombstone that names this actor into `gone`; one naming anything else is `invalid`.
    if (error.reason === 'gone') return deletion();
    return error.transient ? 'unreachable' : 'refused';
  }
}
