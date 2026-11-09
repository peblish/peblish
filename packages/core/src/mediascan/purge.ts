import type { Uuid } from '@peblish/schema/ids';
import { and, eq, gt } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { refusedAsResult } from '../identity/result.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane SAFE. Taking the bytes of a blocked or failed image out of the bucket. The
// object is deleted first (a network call, outside any transaction) and the row's storage key is
// cleared after, so a crash between the two leaves a key that the purge job finds again and
// deletes again (deleting a missing key succeeds).

/**
 * Clears the storage key of a blocked or failed row whose object is gone, and says so. A blocked
 * image under a recorded hold (evidence.hold_until in the future) keeps its key: refused as a
 * no-op, so a hold recorded after the confirmation still wins over a purge that raced it.
 */
export const finishPurge = defineMutation({
  action: 'media.scan',
  emits: ['media.purged'],
  recheck: true,
  async run(t, grant, input: { now: Date }) {
    const { mediaId } = grant.subject;
    const [row] = await t.db
      .select({ scanState: media.scanState, storageKey: media.storageKey })
      .from(media)
      .where(eq(media.id, mediaId))
      .for('no key update');
    if (!row?.storageKey || (row.scanState !== 'blocked' && row.scanState !== 'failed')) return { purged: false };
    const [held] = await t.db
      .select({ id: mediaEvidence.id })
      .from(mediaEvidence)
      .where(and(eq(mediaEvidence.mediaId, mediaId), gt(mediaEvidence.holdUntil, input.now)));
    if (held) return { purged: false };
    await t.db.update(media).set({ storageKey: null }).where(eq(media.id, mediaId));
    await t.emit({ type: 'media.purged', v: 1, mediaId, cause: row.scanState });
    return { purged: true };
  },
});

/** Deletes the object of a blocked or failed row, then clears its key. False when a hold keeps it or the row has nothing to purge. */
export async function purgeBytes(mediaId: Uuid, options: { store?: ObjectStore; now?: Date } = {}): Promise<boolean> {
  const now = options.now ?? new Date();
  const [row] = await db().select({ scanState: media.scanState, storageKey: media.storageKey }).from(media).where(eq(media.id, mediaId));
  if (!row?.storageKey || (row.scanState !== 'blocked' && row.scanState !== 'failed')) return false;
  const [held] = await db()
    .select({ id: mediaEvidence.id })
    .from(mediaEvidence)
    .where(and(eq(mediaEvidence.mediaId, mediaId), gt(mediaEvidence.holdUntil, now)));
  if (held) return false;
  await (options.store ?? s3Store()).delete(row.storageKey);
  const decision = await authorize('media.scan', await systemPrincipal(db(), 'scheduled'), { mediaId });
  if (!decision.ok) throw new Error(`media.scan refused: ${decision.reason}`);
  const finished = await refusedAsResult(() => finishPurge(decision.grant, { now }));
  return finished.ok && finished.purged;
}
