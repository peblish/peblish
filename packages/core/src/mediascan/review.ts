import type { Uuid } from '@peblish/schema/ids';
import type { Principal } from '@peblish/schema/authz';
import { desc, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { logEvidence } from '../evidence/log.ts';
import { holdAuthorities, mediaEvidence, type HoldAuthority } from '../evidence/tables.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { removeContent } from '../moderation/remove.ts';
import { writeModlog } from '../modlog/write.ts';
import type { WriteTx } from '../db/write.ts';
import type { ObjectStore } from '../storage/store.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { blockMedia, retainUntil } from './block.ts';
import { lockHash } from './hash-lock.ts';
import { purgeBytes } from './purge.ts';
import { assertMove } from './state.ts';
import { livePostsUsing } from './usage.ts';

// Owned by lane SAFE. An admin's decisions on a quarantined image. The admin sees the image's
// facts (the manifest), never the image: no UI route renders or links it.

/** Locks the media row and its current incident (the latest evidence row); earlier incidents are history. */
async function lockedEvidence(t: { db: WriteTx }, action: string, mediaId: Uuid) {
  const [row] = await t.db.select().from(media).where(eq(media.id, mediaId)).for('no key update');
  if (!row) throw new Refused(action, 'target.not_found');
  const [evidence] = await t.db
    .select()
    .from(mediaEvidence)
    .where(eq(mediaEvidence.mediaId, mediaId))
    .orderBy(desc(mediaEvidence.createdAt), desc(mediaEvidence.id))
    .limit(1)
    .for('no key update');
  return { row, evidence };
}

/** Admin confirms the match: the image is blocked, its hash listed (clean copies are quarantined), the purge recorded. */
export const confirmMatch = defineMutation({
  action: 'media.review',
  emits: ['media.reviewed', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { note?: string | null; now: Date }) {
    const { mediaId } = grant.subject;
    const { row, evidence } = await lockedEvidence(t, 'media.review', mediaId);
    assertMove('media.review', row.scanState, 'blocked', 'media.not_quarantined');
    if (!evidence) throw new Refused('media.review', 'media.not_quarantined');
    if (evidence.status !== 'open') throw new Refused('media.review', 'media.already_decided');
    await blockMedia(t, {
      action: 'media.review',
      mediaId,
      sha256: row.sha256,
      from: 'quarantined',
      evidence,
      by: grant.actorId,
      now: input.now,
    });
    await t.db
      .update(mediaEvidence)
      .set({
        status: 'confirmed',
        decidedBy: grant.actorId,
        decidedAt: input.now,
        note: input.note ?? null,
        retainUntil: retainUntil(input.now, evidence.holdUntil),
      })
      .where(eq(mediaEvidence.id, evidence.id));
    await logEvidence(t.db, { evidenceId: evidence.id, actorId: grant.actorId, event: 'confirmed', note: input.note });
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({ type: 'media.reviewed', v: 1, mediaId, evidenceId: evidence.id, adminId: grant.actorId, decision: 'confirmed' });
    return { evidenceId: evidence.id };
  },
});

/** Admin releases a false positive: the image is clean again and served. The manifest is kept as the record. */
export const releaseMatch = defineMutation({
  action: 'media.review',
  emits: ['media.reviewed'],
  recheck: true,
  async run(t, grant, input: { note?: string | null; now: Date }) {
    const { mediaId } = grant.subject;
    const { row, evidence } = await lockedEvidence(t, 'media.review', mediaId);
    assertMove('media.review', row.scanState, 'clean', 'media.not_quarantined');
    if (!evidence) throw new Refused('media.review', 'media.not_quarantined');
    if (evidence.status !== 'open') throw new Refused('media.review', 'media.already_decided');
    // A confirmation of a copy quarantines the clean copies under the hash lock; a release takes it
    // too, so it lands wholly before that sweep (and is swept) or after it.
    if (row.sha256) await lockHash(t.db, row.sha256);
    await t.db.update(media).set({ scanState: 'clean', scannedAt: input.now }).where(eq(media.id, mediaId));
    await t.db
      .update(mediaEvidence)
      .set({
        status: 'released',
        decidedBy: grant.actorId,
        decidedAt: input.now,
        note: input.note ?? null,
        retainUntil: retainUntil(input.now, evidence.holdUntil),
      })
      .where(eq(mediaEvidence.id, evidence.id));
    await logEvidence(t.db, { evidenceId: evidence.id, actorId: grant.actorId, event: 'released', note: input.note });
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({ type: 'media.reviewed', v: 1, mediaId, evidenceId: evidence.id, adminId: grant.actorId, decision: 'released' });
    return { evidenceId: evidence.id };
  },
});

const maxReferenceLength = 200;

/**
 * Records a hold: an AFP, NCMEC or NCA preservation direction names a reference and a date, and
 * the hold names which of them directed it. Any hold keeps the manifest, hashes and log past its
 * date. Only an AFP direction keeps the image bytes (the CSAM SOP: imagery is kept on written AFP
 * direction only): while it is in force neither the undecided expiry nor the purge touches them.
 * Under an NCMEC or NCA hold the bytes follow the normal purge. Allowed on a quarantined image or a confirmed one whose bytes
 * are still there and not yet claimed by the purge; a released image, or bytes the purge has
 * claimed or deleted, are `media.already_decided`.
 */
export const recordHold = defineMutation({
  action: 'media.review',
  emits: ['media.reviewed'],
  recheck: true,
  async run(t, grant, input: { authority: HoldAuthority; reference: string; until: Date; now: Date }) {
    const { mediaId } = grant.subject;
    const reference = input.reference.trim();
    if (
      !holdAuthorities.includes(input.authority) ||
      reference.length === 0 ||
      reference.length > maxReferenceLength ||
      !(input.until > input.now)
    )
      throw new Refused('media.review', 'media.hold_invalid');
    const { row, evidence } = await lockedEvidence(t, 'media.review', mediaId);
    if (!evidence || (row.scanState !== 'quarantined' && row.scanState !== 'blocked'))
      throw new Refused('media.review', 'media.not_quarantined');
    // Once the purge has claimed the bytes (purge.ts) they are on their way out: too late for a hold.
    if (evidence.status === 'released' || evidence.purgeStartedAt !== null || (row.scanState === 'blocked' && !row.storageKey))
      throw new Refused('media.review', 'media.already_decided');
    await t.db
      .update(mediaEvidence)
      .set({
        holdAuthority: input.authority,
        holdReference: reference,
        holdUntil: input.until,
        ...(evidence.retainUntil && { retainUntil: retainUntil(evidence.decidedAt ?? input.now, input.until) }),
      })
      .where(eq(mediaEvidence.id, evidence.id));
    await logEvidence(t.db, {
      evidenceId: evidence.id,
      actorId: grant.actorId,
      event: 'hold',
      note: `${input.authority.toUpperCase()} ${reference} until ${input.until.toISOString()}`,
    });
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({ type: 'media.reviewed', v: 1, mediaId, evidenceId: evidence.id, adminId: grant.actorId, decision: 'held' });
    return { evidenceId: evidence.id };
  },
});

async function granted(principal: Principal, mediaId: Uuid) {
  return authorize('media.review', principal, { mediaId });
}

export type ReviewDeps = { store?: ObjectStore; now?: Date };

/**
 * Confirm and purge (the admin's button): block the image, then take its bytes out unless a hold
 * keeps them, and with `removePosts` remove each post that shows it, one by one, as a private
 * moderator removal. A post the removal refuses (already removed, community gone) is counted, not fatal.
 */
export async function confirmQuarantined(
  principal: Principal,
  input: { mediaId: Uuid; removePosts: boolean; note?: string | null },
  deps: ReviewDeps = {},
): Promise<Result<{ removedPosts: number; refusedPosts: number }>> {
  const decision = await granted(principal, input.mediaId);
  if (!decision.ok) return decision;
  const now = deps.now ?? new Date();
  const confirmed = await refusedAsResult(() => confirmMatch(decision.grant, { note: input.note, now }));
  if (!confirmed.ok) return confirmed;
  await purgeBytes(input.mediaId, { store: deps.store, now }).catch(() => undefined);
  let removedPosts = 0;
  let refusedPosts = 0;
  if (input.removePosts)
    for (const post of await livePostsUsing(db(), input.mediaId)) {
      const removal = await authorize('mod.remove', principal, { target: { kind: 'post', id: post.id } });
      const removed = removal.ok ? await refusedAsResult(() => removeContent(removal.grant, { reason: null, public: false })) : removal;
      if (removed.ok) removedPosts += 1;
      else refusedPosts += 1;
    }
  return { ok: true, removedPosts, refusedPosts };
}

export async function releaseQuarantined(
  principal: Principal,
  input: { mediaId: Uuid; note?: string | null },
  deps: ReviewDeps = {},
): Promise<Result<object>> {
  const decision = await granted(principal, input.mediaId);
  if (!decision.ok) return decision;
  return refusedAsResult(() => releaseMatch(decision.grant, { note: input.note, now: deps.now ?? new Date() }));
}

export async function holdQuarantined(
  principal: Principal,
  input: { mediaId: Uuid; authority: HoldAuthority; reference: string; until: Date },
  deps: ReviewDeps = {},
): Promise<Result<object>> {
  const decision = await granted(principal, input.mediaId);
  if (!decision.ok) return decision;
  const { authority, reference, until } = input;
  return refusedAsResult(() => recordHold(decision.grant, { authority, reference, until, now: deps.now ?? new Date() }));
}
