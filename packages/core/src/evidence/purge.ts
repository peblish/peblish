import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, not, or } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { refusedAsResult } from '../identity/result.ts';
import { scanConfig } from '../mediascan/config.ts';
import { expireManifest, expireUndecided } from '../mediascan/expire.ts';
import { heldSql, purgeBytes } from '../mediascan/purge.ts';
import { mediaScans } from '../mediascan/tables.ts';
import type { ObjectStore } from '../storage/store.ts';
import { mediaEvidence } from './tables.ts';

// Owned by lane SAFE. The purge pass (job.ts runs it every minute): end undecided quarantines,
// delete the bytes of blocked and failed images, expire manifests whose retention is over.

/** Rows each step takes per run. */
const perRun = 200;

export type PurgeRun = { expired: number; purged: number; manifests: number };

export async function purgePass(
  options: { store?: ObjectStore; now?: Date; days?: number; signal?: AbortSignal; batch?: number } = {},
): Promise<PurgeRun> {
  const now = options.now ?? new Date();
  const batch = options.batch ?? perRun;
  const days = options.days ?? scanConfig().undecidedPurgeDays;
  const principal = await systemPrincipal(db(), 'scheduled');
  const run: PurgeRun = { expired: 0, purged: 0, manifests: 0 };
  const as = async (mediaId: string) => {
    const decision = await authorize('media.scan', principal, { mediaId });
    if (!decision.ok) throw new Error(`media.scan refused: ${decision.reason}`);
    return decision.grant;
  };
  const cutoff = new Date(now.getTime() - days * 86_400_000);

  // 1. Quarantines nobody decided, past the window and under no hold in force.
  const undecided = await db()
    .select({ id: media.id })
    .from(media)
    .innerJoin(mediaEvidence, eq(mediaEvidence.mediaId, media.id))
    .where(
      and(
        eq(media.scanState, 'quarantined'),
        eq(mediaEvidence.status, 'open'),
        lt(mediaEvidence.createdAt, cutoff),
        or(isNull(mediaEvidence.holdUntil), lt(mediaEvidence.holdUntil, now)),
      ),
    )
    .limit(batch);
  for (const { id } of undecided) {
    if (options.signal?.aborted) return run;
    const expired = await refusedAsResult(async () => expireUndecided(await as(id), { now, days }));
    if (expired.ok && expired.expired) run.expired += 1;
  }

  // 2. Bytes of blocked and failed images; purgeBytes also leaves one under a hold (a hold recorded since this read).
  // Held images are left out before the limit, and rows whose delete failed wait out their back-off,
  // so neither can fill the batch and starve the rest.
  const gone = await db()
    .select({ id: media.id })
    .from(media)
    .leftJoin(mediaScans, eq(mediaScans.mediaId, media.id))
    .where(
      and(
        inArray(media.scanState, ['blocked', 'failed']),
        isNotNull(media.storageKey),
        or(isNull(mediaScans.purgeRetryAt), lte(mediaScans.purgeRetryAt, now)),
        not(heldSql(media.id, now)),
      ),
    )
    .orderBy(media.createdAt)
    .limit(batch);
  for (const { id } of gone) {
    if (options.signal?.aborted) return run;
    if (await purgeBytes(id, { store: options.store, now }).catch(() => false)) run.purged += 1;
  }

  // 3. Manifests whose retention is over (decided, past retain_until, no hold in force).
  const over = await db()
    .select({ id: mediaEvidence.id, mediaId: mediaEvidence.mediaId })
    .from(mediaEvidence)
    .where(
      and(
        ne(mediaEvidence.status, 'open'),
        lt(mediaEvidence.retainUntil, now),
        or(isNull(mediaEvidence.holdUntil), lt(mediaEvidence.holdUntil, now)),
      ),
    )
    .limit(batch);
  for (const { id, mediaId } of over) {
    if (options.signal?.aborted) return run;
    const expired = await refusedAsResult(async () => expireManifest(await as(mediaId), { evidenceId: id, now }));
    if (expired.ok && expired.expired) run.manifests += 1;
  }
  return run;
}
