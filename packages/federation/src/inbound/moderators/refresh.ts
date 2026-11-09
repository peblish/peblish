import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { communitiesDueForMirror, maxMirrored, mirrorModerators } from '@peblish/core/remote/moderators';
import { eq } from 'drizzle-orm';
import { fetchJson, FetchFailure, type Fetcher } from '../../actors/document.ts';
import { importGrant } from '../../actors/grants.ts';
import { ActorResolveError, resolveRemoteActor } from '../../actors/resolve.ts';
import { safeFetch } from '../../actors/safe-fetch.ts';
import { moderatorsFromWire } from '../../mapping/actor.ts';
import { MappingError } from '../../mapping/json.ts';
import { skip } from '../reasons.ts';

// The remote moderators mirror, the network half: read a remote community's moderators
// collection from its own origin, resolve its members to actors, and hand the list to core's
// mirrorModerators. Called when the community announces an Add or Remove on the collection
// (handlers/_collection.ts, which fetches in `prepare` and mirrors in the transaction) and by
// the job before a mirrored row runs out (job.ts).

export type FetchedModerators = { collection: string; moderatorIds: string[] };

const transient = (error: FetchFailure) =>
  error.reason === 'unreachable' || (error.status !== undefined && (error.status >= 500 || error.status === 429 || error.status === 408));

/**
 * The members of `communityId`'s moderators collection, as actor ids. A member that cannot be
 * resolved is left out; a collection that cannot be read is `moderators.unreachable`, or a
 * thrown transient failure when the peer is only down.
 */
export async function fetchModerators(communityId: string, fetch: Fetcher = safeFetch): Promise<FetchedModerators> {
  const [community] = await db()
    .select({ apId: actors.apId, kind: actors.kind, local: actors.local, moderatorsUrl: actors.moderatorsUrl })
    .from(actors)
    .where(eq(actors.id, communityId));
  if (!community || community.kind !== 'Group' || community.local || !community.moderatorsUrl) {
    throw skip('moderators.unreachable', community?.apId ?? communityId);
  }
  const collection = community.moderatorsUrl;
  let members;
  try {
    members = moderatorsFromWire((await fetchJson(collection, fetch)).json).moderatorApIds;
  } catch (error) {
    if (error instanceof FetchFailure && transient(error)) throw error;
    if (error instanceof FetchFailure || error instanceof MappingError) throw skip('moderators.unreachable', collection);
    throw error;
  }
  const moderatorIds: string[] = [];
  for (const apId of members.slice(0, maxMirrored)) {
    try {
      const actor = await resolveRemoteActor(apId, { fetch });
      if ((actor.kind === 'Person' || actor.kind === 'Service') && !actor.deleted) moderatorIds.push(actor.id);
    } catch (error) {
      if (error instanceof ActorResolveError && !error.transient) continue;
      throw error;
    }
  }
  return { collection, moderatorIds };
}

/** Refetches one community's moderators and mirrors them, in a transaction of their own (the job's path). */
export async function mirrorNow(communityId: string, fetch: Fetcher = safeFetch) {
  const fetched = await fetchModerators(communityId, fetch);
  return mirrorModerators(await importGrant('remote.moderators_mirror', { communityId }), fetched);
}

/** Mirrors every community that is due (see communitiesDueForMirror); one failing community does not stop the rest. */
export async function mirrorDue(options: { fetch?: Fetcher; signal?: AbortSignal; limit?: number } = {}): Promise<number> {
  let mirrored = 0;
  for (const { id, apId } of await communitiesDueForMirror(db(), options.limit)) {
    if (options.signal?.aborted) break;
    try {
      await mirrorNow(id, options.fetch);
      mirrored += 1;
    } catch (error) {
      console.error(`moderators of ${apId} could not be mirrored`, error);
    }
  }
  return mirrored;
}
