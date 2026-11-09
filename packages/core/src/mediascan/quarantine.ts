import type { OutboxEvent } from '@peblish/schema/events';
import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import type { WriteTx } from '../db/write.ts';
import { buildManifest, manifestDigest, type Verdict } from '../evidence/manifest.ts';
import { logEvidence } from '../evidence/log.ts';
import { mediaEvidence } from '../evidence/tables.ts';
import { assertMove, type ScanState } from './state.ts';

/** What a mutation that may emit media.quarantined hands its body. */
export type QuarantineTx = { readonly db: WriteTx; emit(event: Extract<OutboxEvent, { type: 'media.quarantined' }>): Promise<void> };

/**
 * Moves a pending or clean media row to quarantined and records why, in the caller's
 * transaction: the evidence row with its manifest and digest, the first line of its log and the
 * `media.quarantined` event. The caller has locked the media row and read `from` under that lock.
 * `action` names the refusal's mutation. A pending row's refusal is media.not_pending; a clean
 * row only arrives here from addBlockedHash, which selects clean rows itself.
 */
export async function quarantine(
  t: QuarantineTx,
  input: { action: string; mediaId: Uuid; from: ScanState; verdict: Verdict; now: Date },
): Promise<Uuid> {
  assertMove(input.action, input.from, 'quarantined', 'media.not_pending');
  const manifest = await buildManifest(t.db, input.mediaId, input.verdict, input.now);
  const verdict = input.verdict;
  const classification = verdict.source === 'list' ? verdict.category : verdict.classification;
  const fresh = {
    source: verdict.source,
    classification,
    matchType: verdict.source === 'list' ? ('exact' as const) : verdict.matchType,
    manifest,
    manifestSha256: manifestDigest(manifest),
  };
  // One evidence row per image: a released image caught by a later list entry starts a new, open case on the same row (its log keeps the history).
  const [previous] = await t.db
    .select({ id: mediaEvidence.id })
    .from(mediaEvidence)
    .where(eq(mediaEvidence.mediaId, input.mediaId))
    .for('no key update');
  const [evidence] = previous
    ? await t.db
        .update(mediaEvidence)
        .set({ ...fresh, status: 'open', decidedBy: null, decidedAt: null, note: null, retainUntil: null })
        .where(eq(mediaEvidence.id, previous.id))
        .returning({ id: mediaEvidence.id })
    : await t.db
        .insert(mediaEvidence)
        .values({ mediaId: input.mediaId, ...fresh })
        .returning({ id: mediaEvidence.id });
  if (!evidence) throw new Error('evidence row not written');
  await t.db.update(media).set({ scanState: 'quarantined', scannedAt: input.now }).where(eq(media.id, input.mediaId));
  await logEvidence(t.db, {
    evidenceId: evidence.id,
    actorId: null,
    event: previous ? 'requarantined' : 'quarantined',
    note: verdict.source,
  });
  await t.emit({
    type: 'media.quarantined',
    v: 1,
    mediaId: input.mediaId,
    evidenceId: evidence.id,
    source: verdict.source,
    classification,
    from: input.from,
  });
  return evidence.id;
}
