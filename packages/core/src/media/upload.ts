import type { Principal } from '@peblish/schema/authz';
import { authorize } from '../authz/authorize.ts';
import type { Result } from '../identity/result.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { recordUpload } from './record.ts';
import { saveImage, type SavedImage } from './save.ts';

/**
 * An image upload for a post (C03). Refused with `site.disabled` while uploads.enabled is
 * false (decision 4: off until M26 scanning is live), before the bytes are looked at. The
 * image is cleaned of its metadata, stored, and recorded with scan_state 'pending'; nothing
 * serves it until lane SAFE marks it clean. `store` defaults to the bucket the S3_* variables name.
 */
export async function uploadImage(
  principal: Principal,
  input: { bytes: Uint8Array; altText?: string | null },
  options: { store?: ObjectStore } = {},
): Promise<Result<SavedImage>> {
  const decision = await authorize('media.upload', principal, {});
  if (!decision.ok) return decision;
  return saveImage({
    ...input,
    store: options.store ?? s3Store(),
    record: (row) => recordUpload(decision.grant, row),
  });
}
