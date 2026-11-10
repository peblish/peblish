import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import {
  communitiesDueForMirror,
  deferMirror,
  emptyMirrorBackoffMs,
  failingMirrorBackoffMs,
  maxMirrored,
  mirrorModerators,
  unreachableMirrorBackoffMs,
} from '@peblish/core/remote/moderators';
import { eq } from 'drizzle-orm';
import { fetchActivity, FetchFailure, type Fetcher } from '../../actors/document.ts';
import { importGrant } from '../../actors/grants.ts';
import { ActorResolveError, resolveRemoteActor } from '../../actors/resolve.ts';
import { safeFetch } from '../../actors/safe-fetch.ts';
import { moderatorsFromWire } from '../../mapping/actor.ts';
import { MappingError } from '../../mapping/json.ts';
import { Skipped, skip } from '../reasons.ts';

// The remote moderators mirror, the network half: read a remote community's moderators
// collection from its own origin, resolve its members to actors, and hand the list to core's
// mirrorModerators. Called when the community announces an Add or Remove on the collection
// (handlers/_collection.ts, which fetches in `prepare` and mirrors in the transaction) and by
// the job before a mirrored row runs out (job.ts).

export type FetchedModerators = { collection: string; moderatorIds: string[] };

const transient = (error: FetchFailure) =>
  error.reason === 'unreachable' || (error.status !== undefined && (error.status >= 500 || error.status === 429 || error.status === 408));

/**
 * The members of `communityId`'s moderators collection, as actor ids. The collection is read
 * from where the community says it is, without following a redirect, and must name itself that
 * way on the community's own origin: a document served from anywhere else is not the community's
 * word on who moderates it. A member that cannot be resolved (a person nobody here has seen,
 * whose server is down or answers no) is left out of this mirror; a collection that cannot be
 * read is `moderators.unreachable`, or a thrown transient failure when the peer is only down.
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
  if (new URL(collection).origin !== new URL(community.apId).origin) throw skip('moderators.unreachable', collection);
  let members;
  try {
    const read = moderatorsFromWire((await fetchActivity(collection, fetch, { maxRedirects: 0 })).json);
    if (read.apId !== collection) throw skip('moderators.unreachable', `${collection} names itself ${read.apId}`);
    members = read.moderatorApIds;
  } catch (error) {
    if (error instanceof Skipped) throw error;
    if (error instanceof FetchFailure && transient(error)) throw error;
    if (error instanceof FetchFailure || error instanceof MappingError) throw skip('moderators.unreachable', collection);
    throw error;
  }
  const moderatorIds: string[] = [];
  for (const apId of members.slice(0, maxMirrored)) {
    try {
      const actor = await resolveRemoteActor(apId, { fetch });
      // A member whose document redirects to another actor is not the person the collection names.
      if (actor.apId !== apId) continue;
      if ((actor.kind === 'Person' || actor.kind === 'Service') && !actor.deleted) moderatorIds.push(actor.id);
    } catch (error) {
      // Left out of this mirror, whether the person is gone or only their server is down: one
      // unreachable moderator must not keep the whole list from being mirrored.
      if (error instanceof ActorResolveError) continue;
      throw error;
    }
  }
  return { collection, moderatorIds };
}

/** Refetches one community's moderators and mirrors them, in a transaction of their own (the job's path). */
export async function mirrorNow(communityId: string, fetch: Fetcher = safeFetch) {
  const fetched = await fetchModerators(communityId, fetch);
  const result = await mirrorModerators(await importGrant('remote.moderators_mirror', { communityId }), fetched);
  // A collection with nobody in it is not asked again every run.
  if (result.added + result.confirmed === 0) deferMirror(communityId, emptyMirrorBackoffMs);
  return result;
}

/**
 * Mirrors every community that is due (see communitiesDueForMirror); one failing community does
 * not stop the rest, and is left alone for a while (an hour when its collection cannot be read,
 * a quarter of an hour when its server is only failing), so failing communities cannot take every
 * slot of the batch from the ones behind them.
 */
export async function mirrorDue(options: { fetch?: Fetcher; signal?: AbortSignal; limit?: number } = {}): Promise<number> {
  let mirrored = 0;
  for (const { id, apId } of await communitiesDueForMirror(db(), options.limit)) {
    if (options.signal?.aborted) break;
    try {
      await mirrorNow(id, options.fetch);
      mirrored += 1;
    } catch (error) {
      console.error(`moderators of ${apId} could not be mirrored`, error);
      deferMirror(id, error instanceof Skipped ? unreachableMirrorBackoffMs : failingMirrorBackoffMs);
    }
  }
  return mirrored;
}
