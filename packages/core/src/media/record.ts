import type { Uuid } from '@peblish/schema/ids';
import { media } from '../db/tables/media.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane B2. The row of an uploaded object that is already in the bucket: the object is
// put first (no network call inside a write transaction), and a refusal here makes the caller
// delete it again (save.ts). The row is scan_state 'pending' and nothing serves it until lane
// SAFE marks it clean. Link previews store nothing: their picture goes through the proxy.

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
  /** Where the image was downloaded from, for the record; null for an upload. */
  remoteUrl: string | null;
};

/** An uploaded image (uploads.enabled; off until M26 scanning is live). */
export const recordUpload = defineMutation({
  action: 'media.upload',
  emits: ['media.stored'],
  // The kill switch can flip between authorize() and the write.
  recheck: true,
  run: async (t, grant, input: RecordedMedia) => {
    await t.db.insert(media).values({
      id: input.id,
      ownerId: grant.actorId,
      kind: 'upload',
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
    await t.emit({ type: 'media.stored', v: 1, mediaId: input.id, ownerId: grant.actorId, kind: 'upload' });
    return { id: input.id };
  },
});
