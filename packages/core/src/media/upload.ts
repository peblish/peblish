import type { Principal } from '@peblish/schema/authz';
import { authorize } from '../authz/authorize.ts';
import type { Result } from '../identity/result.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { scanUpload, type ScanDeps } from '../mediascan/scan.ts';
import { recordUpload } from './record.ts';
import { saveImage, type SavedImage } from './save.ts';

/**
 * An image upload for a post (C03). Refused with `site.disabled` while uploads.enabled is
 * false (decision 4: off until M26 scanning is live), before the bytes are looked at. The
 * image is cleaned of its metadata, stored, recorded with scan_state 'pending' and scanned
 * inline (mediascan/scan.ts): only a clean image is returned. A match is `media.rejected` (the
 * uploader is not told why) and no verdict is `media.scan_unavailable`; scanning fails closed,
 * so with no provider configured an enabled upload is refused, never accepted unscanned.
 * `store` defaults to the bucket the S3_* variables name; `scan` overrides the scanner (tests).
 */
export async function uploadImage(
  principal: Principal,
  input: { bytes: Uint8Array; altText?: string | null },
  options: { store?: ObjectStore; scan?: Omit<ScanDeps, 'store'> } = {},
): Promise<Result<SavedImage>> {
  const decision = await authorize('media.upload', principal, {});
  if (!decision.ok) return decision;
  const store = options.store ?? s3Store();
  const saved = await saveImage({ ...input, store, record: (row) => recordUpload(decision.grant, row) });
  if (!saved.ok) return saved;
  const scanned = await scanUpload(saved.id, { ...options.scan, store });
  if (scanned === 'clean') return saved;
  return { ok: false, reason: scanned === 'quarantined' ? 'media.rejected' : 'media.scan_unavailable' };
}
