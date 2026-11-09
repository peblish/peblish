import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import { deletionLedger } from '../db/tables/site.ts';
import type { WriteTx } from '../db/write.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { assertMove } from './state.ts';
import { mediaBlocklist } from './tables.ts';

/** How long a decided manifest is kept: the decision plus 24 months (privacy.md). A hold postpones it. */
export const retainMonths = 24;

export const retainUntil = (decided: Date, holdUntil: Date | null): Date => {
  const base = new Date(decided);
  base.setUTCMonth(base.getUTCMonth() + retainMonths);
  return holdUntil && holdUntil > base ? holdUntil : base;
};

type Evidence = typeof mediaEvidence.$inferSelect;

/** The list category a confirmed image's hash joins the list under. */
const categoryOf = (evidence: Pick<Evidence, 'source' | 'classification'>) =>
  evidence.source === 'list'
    ? (evidence.classification as typeof mediaBlocklist.$inferInsert.category)
    : evidence.classification === 'csam'
      ? 'csam'
      : 'other';

/**
 * Blocks a quarantined image, in the caller's transaction (an admin's confirmation, or the end
 * of the undecided window): the row becomes `blocked` and deleted, its hash joins the list (so a
 * re-upload is quarantined with no provider call), and a deletion_ledger row makes a backup
 * restore re-apply the purge. The bytes are not touched here: the purge job (or the caller,
 * afterwards) deletes them unless a hold keeps them. `by` is null for the expiry.
 */
export async function blockMedia(
  db: WriteTx,
  input: { action: string; mediaId: Uuid; sha256: string | null; from: 'quarantined'; evidence: Evidence; by: Uuid | null; now: Date },
): Promise<void> {
  assertMove(input.action, input.from, 'blocked', 'media.not_quarantined');
  if (input.sha256)
    await db
      .insert(mediaBlocklist)
      .values({
        kind: 'sha256',
        value: input.sha256,
        category: categoryOf(input.evidence),
        reason: 'confirmed quarantine',
        addedBy: input.by,
      })
      .onConflictDoNothing();
  await db.update(media).set({ scanState: 'blocked', deletedAt: input.now }).where(eq(media.id, input.mediaId));
  await db.insert(deletionLedger).values({
    subjectKind: 'media',
    subjectId: input.mediaId,
    reason: 'media.blocked',
    requestedBy: input.by,
    details: { evidenceId: input.evidence.id },
  });
}
