import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import { logEvidence } from '../evidence/log.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { defineMutation } from '../tx/mutation.ts';
import { blockMedia, retainUntil } from './block.ts';
import { holdKeepsBytes } from './purge.ts';

// Owned by lane SAFE. What the instance does by itself with quarantined images nobody decided.

/**
 * Ends the undecided window of one quarantined image: when its evidence is still open, older than
 * `days` and under no AFP hold in force (an NCMEC or NCA hold keeps the record, not the image), the image is blocked exactly as an admin's confirmation
 * blocks it (hash listed, clean copies quarantined, ledger row, row deleted) with no admin
 * named. Anything else is left as it is. The bytes are purged by the purge job.
 */
export const expireUndecided = defineMutation({
  action: 'media.scan',
  emits: ['media.scanned', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { now: Date; days: number }) {
    const { mediaId } = grant.subject;
    const [row] = await t.db.select().from(media).where(eq(media.id, mediaId)).for('no key update');
    if (row?.scanState !== 'quarantined') return { expired: false };
    const [evidence] = await t.db
      .select()
      .from(mediaEvidence)
      .where(and(eq(mediaEvidence.mediaId, mediaId), eq(mediaEvidence.status, 'open')))
      .for('no key update');
    const cutoff = new Date(input.now.getTime() - input.days * 86_400_000);
    if (!evidence || evidence.createdAt > cutoff || holdKeepsBytes(evidence, input.now)) return { expired: false };
    await blockMedia(t, { action: 'media.scan', mediaId, sha256: row.sha256, from: 'quarantined', evidence, by: null, now: input.now });
    await t.db
      .update(mediaEvidence)
      .set({
        status: 'confirmed',
        decidedAt: input.now,
        note: `undecided for ${input.days} days`,
        retainUntil: retainUntil(input.now, evidence.holdUntil),
      })
      .where(eq(mediaEvidence.id, evidence.id));
    await logEvidence(t.db, { evidenceId: evidence.id, actorId: null, event: 'expired', note: `undecided for ${input.days} days` });
    await t.emit({ type: 'media.scanned', v: 1, mediaId, from: 'quarantined', to: 'blocked' });
    return { expired: true };
  },
});

/**
 * Deletes one evidence row (an incident of the image) once its retention is over: decided,
 * retain_until past and no hold in force. The log line that says so outlives it (the log has no
 * foreign key).
 */
export const expireManifest = defineMutation({
  action: 'media.scan',
  emits: ['media.purged'],
  recheck: true,
  async run(t, grant, input: { evidenceId: Uuid; now: Date }) {
    const { mediaId } = grant.subject;
    const [evidence] = await t.db
      .select()
      .from(mediaEvidence)
      .where(and(eq(mediaEvidence.id, input.evidenceId), eq(mediaEvidence.mediaId, mediaId)))
      .for('no key update');
    const over =
      evidence &&
      evidence.status !== 'open' &&
      evidence.retainUntil !== null &&
      evidence.retainUntil < input.now &&
      (evidence.holdUntil === null || evidence.holdUntil < input.now);
    if (!over) return { expired: false };
    await t.db.delete(mediaEvidence).where(and(eq(mediaEvidence.id, evidence.id)));
    await logEvidence(t.db, { evidenceId: evidence.id, actorId: null, event: 'manifest_expired' });
    return { expired: true };
  },
});
