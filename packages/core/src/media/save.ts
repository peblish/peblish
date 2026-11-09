import { createHash } from 'node:crypto';
import type { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { uuidv7 } from 'uuidv7';
import { refusedAsResult, type Result } from '../identity/result.ts';
import type { ObjectStore } from '../storage/store.ts';
import { cleanImage, ImageError, imageExtensions } from './clean.ts';
import type { RecordedMedia } from './record.ts';

/** The most an upload may weigh as received (Lemmy's pict-rs default is 10 MB too). */
export const maxUploadBytes = 10 * 1024 * 1024;
export const maxAltTextLength = 1000;

export type SavedImage = Pick<RecordedMedia, 'id' | 'storageKey' | 'mimeType' | 'byteSize' | 'width' | 'height' | 'sha256'>;

const imageRefusals = {
  unsupported: 'media.unsupported_type',
  invalid: 'media.invalid_image',
  too_large: 'media.too_large',
} as const satisfies Record<ImageError['code'], RefusalReason>;

/**
 * The shared path of an upload and a preview thumbnail, after the caller's authorize(): check
 * the size, clean the image of its metadata (clean.ts), put the object, then `record` the row
 * (a mutation that emits media.stored). The network call to the bucket comes before the
 * transaction, so the object is deleted again when the row is refused or the write fails.
 * Refusals come back as results, as in registration.
 */
export async function saveImage(options: {
  bytes: Uint8Array;
  altText?: string | null;
  remoteUrl?: string | null;
  store: ObjectStore;
  record: (row: RecordedMedia) => Promise<{ id: Uuid }>;
}): Promise<Result<SavedImage>> {
  const { store } = options;
  if (options.bytes.byteLength > maxUploadBytes) return { ok: false, reason: 'media.too_large' };
  let image;
  try {
    image = cleanImage(options.bytes);
  } catch (error) {
    if (error instanceof ImageError) return { ok: false, reason: imageRefusals[error.code] };
    throw error;
  }
  const id = uuidv7();
  const saved: SavedImage = {
    id,
    storageKey: `media/${id}.${imageExtensions[image.mimeType]}`,
    mimeType: image.mimeType,
    byteSize: image.bytes.byteLength,
    width: image.width,
    height: image.height,
    sha256: createHash('sha256').update(image.bytes).digest('hex'),
  };
  await store.put(saved.storageKey, image.bytes, image.mimeType);
  try {
    const recorded = await refusedAsResult(() =>
      options.record({ ...saved, altText: options.altText?.slice(0, maxAltTextLength) || null, remoteUrl: options.remoteUrl ?? null }),
    );
    if (recorded.ok) return { ok: true, ...saved };
    await store.delete(saved.storageKey);
    return recorded;
  } catch (error) {
    await store.delete(saved.storageKey).catch(() => undefined);
    throw error;
  }
}
