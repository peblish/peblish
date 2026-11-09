import { eq, sql } from 'drizzle-orm';
import { media } from '../db/tables/media.ts';
import type { Verdict } from '../evidence/manifest.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { quarantine } from './quarantine.ts';
import { assertMove } from './state.ts';
import { mediaScans } from './tables.ts';

// Owned by lane SAFE. The writes of the scan pipeline: leasing a pending row, and recording what
// the scan found. The scan itself (scan.ts) reads the object and calls providers outside any
// transaction; only the outcome comes in here.

/** How long a worker owns a claimed row, how old a pending row must be before the job takes it, and how many tries it gets. */
export const scanLimits = { leaseMs: 60_000, jobMinAgeMs: 30_000, maxAttempts: 5, batch: 20 } as const;

export type ScanOutcome = { state: 'clean' } | { state: 'failed'; error: string } | { state: 'quarantined'; verdict: Verdict };

export type Claimed = { mediaId: string; attempts: number };

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
    const now = input.now.toISOString();
    const lease = new Date(input.now.getTime() + scanLimits.leaseMs).toISOString();
    const notLeased = sql`not exists (select 1 from ${mediaScans} s where s.media_id = m.id and s.lease_until > ${now}::timestamptz)`;
    const due =
      mediaId === null
        ? sql`select m.id from ${media} m
              where m.scan_state = 'pending' and m.created_at < ${new Date(input.now.getTime() - scanLimits.jobMinAgeMs).toISOString()}::timestamptz and ${notLeased}
              order by m.created_at limit ${scanLimits.batch} for update of m skip locked`
        : sql`select m.id from ${media} m where m.id = ${mediaId} and m.scan_state = 'pending' and ${notLeased} for update of m skip locked`;
    const claimed = await t.db.execute<{ mediaId: string; attempts: number }>(sql`
      insert into ${mediaScans} (media_id, attempts, lease_until)
      select id, 1, ${lease}::timestamptz from (${due}) due
      on conflict (media_id) do update set attempts = ${mediaScans}.attempts + 1, lease_until = excluded.lease_until
      returning media_id as "mediaId", attempts`);
    return [...claimed];
  },
});

/**
 * Records a scan's outcome for a pending row and ends its lease: clean, failed (no verdict; the
 * caller then deletes the bytes) or quarantined (evidence, manifest and log in this
 * transaction). Refuses a row that is not pending, so a second result for one row changes nothing.
 */
export const recordScan = defineMutation({
  action: 'media.scan',
  emits: ['media.scanned', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { outcome: ScanOutcome; now: Date }) {
    const { mediaId } = grant.subject;
    const [row] = await t.db.select({ scanState: media.scanState }).from(media).where(eq(media.id, mediaId)).for('no key update');
    if (!row) throw new Refused('media.scan', 'target.not_found');
    const { outcome, now } = input;
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
        set: { leaseUntil: null, lastError: outcome.state === 'failed' ? outcome.error.slice(0, 200) : null },
      });
  },
});
