import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNull } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { findBlocked, listVerdict } from './blocklist.ts';
import { lockHash } from './hash-lock.ts';
import type { BlockCategory } from './list.ts';
import { quarantine, type QuarantineTx } from './quarantine.ts';
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
export const categoryOf = (evidence: Pick<Evidence, 'source' | 'classification'>): BlockCategory =>
  evidence.source === 'list' ? (evidence.classification as BlockCategory) : evidence.classification === 'csam' ? 'csam' : 'other';

/**
 * Blocks a quarantined image, in the caller's transaction (an admin's confirmation, or the end
 * of the undecided window): the row becomes `blocked` and deleted, and its hash is listed with
 * its clean copies quarantined (listBlockedHash). A deletion_ledger row, naming the hash and its
 * category, makes a backup restore re-apply all of it (tools/cutover/src/drill.ts). The bytes are
 * not touched here: the purge job (or the caller, afterwards) deletes them unless a hold keeps
 * them. `by` is null for the expiry. The caller has locked the quarantined row (so it takes the
 * hash lock after it: hash-lock.ts). The hash lock comes before the ledger row, so the ledger
 * orders this block and a list change by hand on the same hash (list.ts) as the list saw them.
 */
export async function blockMedia(
  t: QuarantineTx,
  input: { action: string; mediaId: Uuid; sha256: string | null; from: 'quarantined'; evidence: Evidence; by: Uuid | null; now: Date },
): Promise<{ quarantinedCopies: number }> {
  assertMove(input.action, input.from, 'blocked', 'media.not_quarantined');
  const category = categoryOf(input.evidence);
  if (input.sha256) await lockHash(t.db, input.sha256);
  await t.db.update(media).set({ scanState: 'blocked', deletedAt: input.now }).where(eq(media.id, input.mediaId));
  await t.db.insert(deletionLedger).values({
    subjectKind: 'media',
    subjectId: input.mediaId,
    reason: 'media.blocked',
    requestedBy: input.by,
    details: { evidenceId: input.evidence.id, sha256: input.sha256, category },
  });
  if (!input.sha256) return { quarantinedCopies: 0 };
  const { quarantinedCopies } = await listBlockedHash(t, {
    action: input.action,
    sha256: input.sha256,
    category,
    by: input.by,
    now: input.now,
  });
  return { quarantinedCopies };
}

/**
 * The hash half of a block, in the caller's transaction: `sha256` joins the list (so a re-upload
 * is quarantined with no provider call) unless it is there already, and every clean, undeleted
 * copy with that hash is quarantined under the entry. Used by blockMedia, by adding a hash by
 * hand (list.ts, which refuses a listed hash first) and by the restore drill when it re-applies a
 * media.blocked or media.hash_added ledger row. Takes the hash lock; the caller holds no clean
 * copy's row lock (hash-lock.ts).
 */
export async function listBlockedHash(
  t: QuarantineTx,
  input: { action: string; sha256: string; category: BlockCategory; reason?: string | null; by: Uuid | null; now: Date },
): Promise<{ entryId: Uuid; quarantinedCopies: number }> {
  await lockHash(t.db, input.sha256);
  const reason = input.reason === undefined ? 'confirmed quarantine' : input.reason;
  await t.db
    .insert(mediaBlocklist)
    .values({ kind: 'sha256', value: input.sha256, category: input.category, reason, addedBy: input.by })
    .onConflictDoNothing();
  const entry = await findBlocked(t.db, input.sha256);
  if (!entry) throw new Error('list entry not written');
  const copies = await t.db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.sha256, input.sha256), eq(media.scanState, 'clean'), isNull(media.deletedAt)))
    .for('no key update');
  for (const copy of copies)
    await quarantine(t, { action: input.action, mediaId: copy.id, from: 'clean', verdict: listVerdict(entry), now: input.now });
  return { entryId: entry.id, quarantinedCopies: copies.length };
}
