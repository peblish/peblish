import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';

// What /media/<id> may serve: an uploaded image whose scan found nothing, and that nobody has
// taken down. Pending, quarantined, blocked and failed rows, deleted rows and unknown ids are
// all the same absence to the caller (null): the route answers one identical 404 for each.

export type Servable = { mimeType: string; sha256: string; byteSize: number; body: Uint8Array | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The clean image `id` names, with its bytes unless `withBody` is false (a HEAD request), or null. */
export async function findServable(id: string, options: { withBody: boolean; store?: ObjectStore }): Promise<Servable | null> {
  if (!uuid.test(id)) return null;
  const [row] = await db()
    .select({ storageKey: media.storageKey, mimeType: media.mimeType, sha256: media.sha256, byteSize: media.byteSize })
    .from(media)
    .where(and(eq(media.id, id.toLowerCase()), eq(media.kind, 'upload'), eq(media.scanState, 'clean'), isNull(media.deletedAt)));
  if (!row?.storageKey || !row.mimeType || !row.sha256 || row.byteSize === null) return null;
  if (!options.withBody) return { mimeType: row.mimeType, sha256: row.sha256, byteSize: row.byteSize, body: null };
  const object = await (options.store ?? s3Store()).get(row.storageKey);
  return object ? { mimeType: row.mimeType, sha256: row.sha256, byteSize: object.body.byteLength, body: object.body } : null;
}
