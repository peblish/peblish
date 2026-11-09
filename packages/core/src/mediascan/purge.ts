import type { Uuid } from '@peblish/schema/ids';
import { desc, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { logEvidence } from '../evidence/log.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { refusedAsResult } from '../identity/result.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane SAFE. Taking the bytes of a blocked or failed image out of the bucket, in three
// steps: claim the purge (beginPurge) under the media and evidence locks, delete the object (a
// network call, outside any transaction), then clear the row's storage key (finishPurge). A hold
// and a claim serialise on those locks: a hold recorded first stops the claim, and a claim made
// first makes the hold refused (recordHold). A crash after the claim leaves a key that the purge
// job finds and deletes again (deleting a missing key succeeds).

/**
 * Claims the purge of a blocked or failed row's bytes and returns the key to delete, or null when
 * there is nothing to purge or a hold in force keeps the bytes. Marks the image's current incident
 * as deleting (purge_started_at), with a log line, the first time.
 */
export const beginPurge = defineMutation({
  action: 'media.scan',
  emits: ['media.purged'],
  recheck: true,
  async run(t, grant, input: { now: Date }): Promise<{ storageKey: string | null }> {
    const { mediaId } = grant.subject;
    const [row] = await t.db
      .select({ scanState: media.scanState, storageKey: media.storageKey })
      .from(media)
      .where(eq(media.id, mediaId))
      .for('no key update');
    if (!row?.storageKey || (row.scanState !== 'blocked' && row.scanState !== 'failed')) return { storageKey: null };
    const incidents = await t.db
      .select({ id: mediaEvidence.id, holdUntil: mediaEvidence.holdUntil, purgeStartedAt: mediaEvidence.purgeStartedAt })
      .from(mediaEvidence)
      .where(eq(mediaEvidence.mediaId, mediaId))
      .orderBy(desc(mediaEvidence.createdAt), desc(mediaEvidence.id))
      .for('no key update');
    // A hold on any incident keeps the bytes; the current (latest) one is the one a hold is recorded on.
    if (incidents.some((incident) => incident.holdUntil && incident.holdUntil > input.now)) return { storageKey: null };
    const [current] = incidents;
    if (current && current.purgeStartedAt === null) {
      await t.db.update(mediaEvidence).set({ purgeStartedAt: input.now }).where(eq(mediaEvidence.id, current.id));
      await logEvidence(t.db, { evidenceId: current.id, actorId: null, event: 'purge_started' });
    }
    return { storageKey: row.storageKey };
  },
});

/** Clears the storage key of a blocked or failed row whose object beginPurge claimed and the caller deleted, and says so. */
export const finishPurge = defineMutation({
  action: 'media.scan',
  emits: ['media.purged'],
  recheck: true,
  async run(t, grant, _input: { now: Date }) {
    const { mediaId } = grant.subject;
    const [row] = await t.db
      .select({ scanState: media.scanState, storageKey: media.storageKey })
      .from(media)
      .where(eq(media.id, mediaId))
      .for('no key update');
    if (!row?.storageKey || (row.scanState !== 'blocked' && row.scanState !== 'failed')) return { purged: false };
    await t.db.update(media).set({ storageKey: null }).where(eq(media.id, mediaId));
    await t.emit({ type: 'media.purged', v: 1, mediaId, cause: row.scanState });
    return { purged: true };
  },
});

/** Deletes the object of a blocked or failed row, then clears its key. False when a hold keeps it or the row has nothing to purge. */
export async function purgeBytes(mediaId: Uuid, options: { store?: ObjectStore; now?: Date } = {}): Promise<boolean> {
  const now = options.now ?? new Date();
  const decision = await authorize('media.scan', await systemPrincipal(db(), 'scheduled'), { mediaId });
  if (!decision.ok) return false;
  const begun = await refusedAsResult(() => beginPurge(decision.grant, { now }));
  if (!begun.ok || begun.storageKey === null) return false;
  await (options.store ?? s3Store()).delete(begun.storageKey);
  const finished = await refusedAsResult(() => finishPurge(decision.grant, { now }));
  return finished.ok && finished.purged;
}
