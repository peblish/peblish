import { createHash } from 'node:crypto';
import { db, type Queryable } from '../db/read.ts';
import { findBlocked } from '../mediascan/blocklist.ts';

// The blocked-image list applied to what the remote-media proxy fetched: the same exact SHA-256
// of the bytes the list holds for uploads (mediascan/blocklist.ts), checked for every answer,
// private ones too, so a listed image is never served through the proxy.

/** The image's SHA-256, lowercase hex. */
export const imageSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Whether the blocked-image list holds this hash. */
export async function hashListed(sha256: string, q: Queryable = db()): Promise<boolean> {
  return (await findBlocked(q, sha256)) !== null;
}
