import type { Uuid } from '@peblish/schema/ids';
import { media } from '../db/tables/media.ts';
import { defineMutation, type MutationTx } from '../tx/mutation.ts';
import type { Authorized } from '../authz/brand.ts';

// Owned by lane B2. The row of an object that is already in the bucket: the object is put
// first (no network call inside a write transaction), and a refusal here makes the caller
// delete it again (save.ts). Both mutations insert scan_state 'pending' and nothing serves
// the row until lane SAFE marks it clean.

/** What the object is; the owner is the acting actor and the key is `media/<id>.<extension>`. */
export type RecordedMedia = {
  /** Chosen by the caller, so the object could be named after the row before the transaction. */
  id: Uuid;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  altText: string | null;
  /** Where a thumbnail's image was downloaded from, for the record; null for an upload. */
  remoteUrl: string | null;
};

async function insertMedia(
  t: MutationTx<'media.stored'>,
  grant: Authorized<'media.upload'> | Authorized<'media.thumbnail'>,
  kind: 'upload' | 'thumbnail',
  input: RecordedMedia,
) {
  await t.db.insert(media).values({
    id: input.id,
    ownerId: grant.actorId,
    kind,
    storageKey: input.storageKey,
    remoteUrl: input.remoteUrl,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    width: input.width,
    height: input.height,
    sha256: input.sha256,
    altText: input.altText,
    scanState: 'pending',
  });
  await t.emit({ type: 'media.stored', v: 1, mediaId: input.id, ownerId: grant.actorId, kind });
  return { id: input.id };
}

/** An uploaded image (uploads.enabled; off until M26 scanning is live). */
export const recordUpload = defineMutation({
  action: 'media.upload',
  emits: ['media.stored'],
  // The kill switch can flip between authorize() and the write.
  recheck: true,
  run: (t, grant, input: RecordedMedia) => insertMedia(t, grant, 'upload', input),
});

/** The thumbnail of a link preview (remote_media.enabled). */
export const recordThumbnail = defineMutation({
  action: 'media.thumbnail',
  emits: ['media.stored'],
  recheck: true,
  run: (t, grant, input: RecordedMedia) => insertMedia(t, grant, 'thumbnail', input),
});
