import { createHash } from 'node:crypto';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { refusedAsResult } from '../identity/result.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { eq } from 'drizzle-orm';
import { findBlocked } from './blocklist.ts';
import { scanConfig, type ScanConfig } from './config.ts';
import { purgeBytes } from './purge.ts';
import { ScanError, type ScanProvider } from './provider.ts';
import { configuredProviders } from './providers.ts';
import { claimScan, recordScan, scanLimits, type Claimed, type ScanOutcome } from './record.ts';
import type { Verdict } from '../evidence/manifest.ts';

// Owned by lane SAFE. Scanning an uploaded image: the local SHA-256 list first, then each external
// provider, all outside any transaction (a provider call is a network call). Only the outcome is
// written, through recordScan. Fail closed: no provider (and MEDIASCAN_LOCAL_ONLY unset), or any
// error, timeout, non-2xx or malformed answer, is `failed`, never `clean`.

export type ScanDeps = {
  store?: ObjectStore;
  /** Replaces the providers the environment configures (tests). */
  providers?: readonly ScanProvider[];
  config?: ScanConfig;
  signal?: AbortSignal;
  now?: () => Date;
};

type Decided = {
  outcome: ScanOutcome;
  /** A failure that may pass: the job tries again, up to scanLimits.maxAttempts. */ retryable: boolean;
};

const failed = (error: string, retryable = false): Decided => ({ outcome: { state: 'failed', error }, retryable });

async function decide(
  row: { storageKey: string | null; mimeType: string | null; sha256: string | null },
  deps: ScanDeps,
  config: ScanConfig,
): Promise<Decided> {
  if (!row.storageKey || !row.mimeType || !row.sha256) return failed('the media row has no stored object');
  const listed = await findBlocked(db(), row.sha256);
  if (listed) {
    const verdict: Verdict = { source: 'list', entryId: listed.id, category: listed.category, listedAt: listed.createdAt.toISOString() };
    return { outcome: { state: 'quarantined', verdict }, retryable: false };
  }
  if (config.localOnly) return { outcome: { state: 'clean' }, retryable: false };
  const providers = deps.providers ?? configuredProviders(config);
  if (providers.length === 0) return failed('no scan provider is configured');
  // A bucket outage is an outcome like a provider outage: retried, and final on the last attempt.
  // The error itself is not kept (it can name the endpoint).
  const object = await (deps.store ?? s3Store()).get(row.storageKey).catch(() => undefined);
  if (object === undefined) return failed('the stored object could not be read', true);
  if (!object) return failed('the stored object is missing', true);
  const sha256 = createHash('sha256').update(object.body).digest('hex');
  if (sha256 !== row.sha256) return failed('the stored object does not match its recorded hash');
  // One deadline for the whole scan, so an upload waits at most MEDIASCAN_TIMEOUT_MS.
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  const errors: string[] = [];
  let match: Extract<Verdict, { source: 'provider' }> | null = null;
  for (const provider of providers) {
    try {
      const verdict = await provider.scan({ bytes: object.body, mimeType: row.mimeType, sha256 }, signal);
      if (verdict.result === 'match' && !match) {
        const listVersion = await provider.version?.(signal).catch(() => null);
        match = {
          source: 'provider',
          provider: provider.name,
          classification: verdict.classification,
          matchType: verdict.matchType,
          raw: verdict.raw,
          listVersion: listVersion ?? null,
        };
      }
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof ScanError ? error.message : 'unexpected error'}`);
    }
  }
  // A match is quarantined even if another provider failed; an error with no match is never clean.
  if (match) return { outcome: { state: 'quarantined', verdict: match }, retryable: false };
  if (errors.length > 0) return failed(errors.join('; '), true);
  return { outcome: { state: 'clean' }, retryable: false };
}

export type ScanResult = ScanOutcome['state'] | 'retry' | 'settled-elsewhere';

/**
 * Scans one claimed row and records the outcome. A failure that may pass leaves the row pending
 * under its lease for the job to try again, unless `final` (the inline scan of an upload, which
 * answers its uploader now) or the row is out of attempts. `settled-elsewhere`: another worker
 * recorded a result first, or claimed the row again after this claim's lease ran out, and nothing
 * changed here.
 */
export async function scanClaimed(claim: Claimed, deps: ScanDeps & { final?: boolean } = {}): Promise<ScanResult> {
  const config = deps.config ?? scanConfig();
  const [row] = await db()
    .select({ storageKey: media.storageKey, mimeType: media.mimeType, sha256: media.sha256 })
    .from(media)
    .where(eq(media.id, claim.mediaId));
  const decided = row ? await decide(row, deps, config) : failed('the media row is gone');
  if (decided.outcome.state === 'failed' && decided.retryable && !deps.final && claim.attempts < scanLimits.maxAttempts) return 'retry';
  const now = (deps.now ?? (() => new Date()))();
  const decision = await authorize('media.scan', await systemPrincipal(db(), 'scheduled'), { mediaId: claim.mediaId as Uuid });
  if (!decision.ok) throw new Error(`media.scan refused: ${decision.reason}`);
  const recorded = await refusedAsResult(async () => {
    await recordScan(decision.grant, { outcome: decided.outcome, now, token: claim.token });
    return {};
  });
  return recorded.ok ? decided.outcome.state : 'settled-elsewhere';
}

/**
 * The scan of a fresh upload, inline, within MEDIASCAN_TIMEOUT_MS: the caller answers its
 * uploader with the result. `clean` is the only result that lets the upload stand. A `failed`
 * scan deletes the object at once, so an image post exists only for a clean image (peers fetch
 * /media/<id> on federation). The job is the backstop if this call never returns.
 */
export async function scanUpload(mediaId: Uuid, deps: ScanDeps = {}): Promise<'clean' | 'quarantined' | 'failed'> {
  const decision = await authorize('media.scan_claim', await systemPrincipal(db(), 'scheduled'), { mediaId });
  if (!decision.ok) throw new Error(`media.scan_claim refused: ${decision.reason}`);
  const [claim] = await claimScan(decision.grant, { now: (deps.now ?? (() => new Date()))() });
  // Not claimable: another worker has it or it is no longer pending. Nothing was decided here.
  if (!claim) return 'failed';
  const result = await scanClaimed(claim, { ...deps, final: true });
  if (result === 'clean' || result === 'quarantined') return result;
  if (result === 'failed') await purgeBytes(mediaId, { store: deps.store }).catch(() => undefined);
  return 'failed';
}
