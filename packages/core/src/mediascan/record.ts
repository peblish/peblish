import { eq, sql } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import type { Verdict } from '../evidence/manifest.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { findBlocked, listVerdict } from './blocklist.ts';
import { lockHash } from './hash-lock.ts';
import { quarantine } from './quarantine.ts';
import { assertMove } from './state.ts';
import { mediaScans } from './tables.ts';

// Owned by lane SAFE. The writes of the scan pipeline: leasing a pending row, and recording what
// the scan found. The scan itself (scan.ts) reads the object and calls providers outside any
// transaction; only the outcome comes in here.

/** How long a worker owns a claimed row, how old a pending row must be before the job takes it, and how many tries it gets. */
export const scanLimits = { leaseMs: 60_000, jobMinAgeMs: 30_000, maxAttempts: 5, batch: 20 } as const;

export type ScanOutcome = { state: 'clean' } | { state: 'failed'; error: string } | { state: 'quarantined'; verdict: Verdict };

const notLeased = (now: Date) =>
  sql`not exists (select 1 from ${mediaScans} s where s.media_id = m.id and s.lease_until > ${now.toISOString()}::timestamptz)`;

/** The next due pending rows, oldest first, locked (skipping rows another worker holds); uses the partial index media_scan_pending. */
export const dueBatch = (now: Date) =>
  sql`select m.id from ${media} m
      where m.scan_state = 'pending' and m.created_at < ${new Date(now.getTime() - scanLimits.jobMinAgeMs).toISOString()}::timestamptz and ${notLeased(now)}
      order by m.created_at limit ${scanLimits.batch} for update of m skip locked`;

const dueRow = (mediaId: string, now: Date) =>
  sql`select m.id from ${media} m where m.id = ${mediaId} and m.scan_state = 'pending' and ${notLeased(now)} for update of m skip locked`;

export type Claimed = { mediaId: string; attempts: number; token: string };

/**
 * Leases pending rows for scanning and counts the attempt. With a `mediaId` subject it takes that
 * one row (the inline scan of an upload, whatever its age); with none it takes up to `batch`
 * rows older than `jobMinAgeMs`, oldest first (partial index media_scan_pending), skipping rows
 * another worker is changing. A row under a live lease is never taken twice.
 */
export const claimScan = defineMutation({
  action: 'media.scan_claim',
  emits: ['media.scanned'],
  recheck: true,
  async run(t, grant, input: { now: Date }): Promise<Claimed[]> {
    const { mediaId } = grant.subject;
    const lease = new Date(input.now.getTime() + scanLimits.leaseMs).toISOString();
    const due = mediaId === null ? dueBatch(input.now) : dueRow(mediaId, input.now);
    const claimed = await t.db.execute<Claimed>(sql`
      insert into ${mediaScans} (media_id, attempts, lease_until, claim_token)
      select id, 1, ${lease}::timestamptz, gen_random_uuid() from (${due}) due
      on conflict (media_id) do update
        set attempts = ${mediaScans}.attempts + 1, lease_until = excluded.lease_until, claim_token = excluded.claim_token
      returning media_id as "mediaId", attempts, claim_token as token`);
    return [...claimed];
  },
});

/**
 * Records a scan's outcome for a pending row and ends its lease: clean, failed (no verdict; the
 * caller then deletes the bytes) or quarantined (evidence, manifest and log in this
 * transaction). A clean or failed result for an image whose hash was listed meanwhile is recorded
 * as the list match it now is. Returns the state recorded. Refuses a row that is not pending, so a second result for one row changes
 * nothing, and a `token` that is not the row's current claim (a worker whose lease ran out and
 * whose row was claimed again), so only the current claim settles it.
 */
export const recordScan = defineMutation({
  action: 'media.scan',
  emits: ['media.scanned', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { outcome: ScanOutcome; now: Date; token: string }) {
    const { mediaId } = grant.subject;
    const [row] = await t.db
      .select({ scanState: media.scanState, sha256: media.sha256 })
      .from(media)
      .where(eq(media.id, mediaId))
      .for('no key update');
    if (!row) throw new Refused('media.scan', 'target.not_found');
    const { now } = input;
    let { outcome } = input;
    // A scan result is for a pending row only; a clean row reaches quarantine through addBlockedHash.
    if (row.scanState !== 'pending') throw new Refused('media.scan', 'media.not_pending');
    const [claim] = await t.db
      .select({ token: mediaScans.claimToken })
      .from(mediaScans)
      .where(eq(mediaScans.mediaId, mediaId))
      .for('no key update');
    if (claim?.token !== input.token) throw new Refused('media.scan', 'media.not_pending');
    // The list may have gained this hash while the scan ran (outside any transaction): under the
    // hash lock, a listed hash is a list match whatever the scan found, as at the start of a scan.
    if (row.sha256 && outcome.state !== 'quarantined') {
      await lockHash(t.db, row.sha256);
      const listed = await findBlocked(t.db, row.sha256);
      if (listed) outcome = { state: 'quarantined', verdict: listVerdict(listed) };
    }
    if (outcome.state === 'quarantined') {
      await quarantine(t, { action: 'media.scan', mediaId, from: row.scanState, verdict: outcome.verdict, now });
    } else {
      assertMove('media.scan', row.scanState, outcome.state, 'media.not_pending');
      await t.db.update(media).set({ scanState: outcome.state, scannedAt: now }).where(eq(media.id, mediaId));
      await t.emit({ type: 'media.scanned', v: 1, mediaId, from: row.scanState, to: outcome.state });
    }
    await t.db
      .insert(mediaScans)
      .values({ mediaId, attempts: 0, lastError: outcome.state === 'failed' ? outcome.error.slice(0, 200) : null })
      .onConflictDoUpdate({
        target: mediaScans.mediaId,
        set: { leaseUntil: null, claimToken: null, lastError: outcome.state === 'failed' ? outcome.error.slice(0, 200) : null },
      });
    return { state: outcome.state };
  },
});
