import { createHash } from 'node:crypto';
import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { media } from '../db/tables/media.ts';
import { pendingDeliveriesNaming, postsNaming } from '../mediascan/usage.ts';

// The evidence manifest of a quarantined image: facts about it, never the image. The one stored
// object stays where it is (private bucket, nothing serves a non-clean row). No request address
// is recorded: uploads are not tied to a network address anywhere in this system.

export type Verdict =
  | { source: 'list'; entryId: Uuid; category: string; listedAt: string }
  | {
      source: 'provider';
      provider: string;
      classification: string;
      matchType: 'exact' | 'near' | null;
      raw: unknown;
      listVersion: string | null;
    };

export type Manifest = {
  v: 1;
  mediaId: Uuid;
  sha256: string | null;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  storageKey: string | null;
  uploadedAt: string;
  quarantinedAt: string;
  uploader: { actorId: Uuid; apId: string } | null;
  verdict: Verdict;
  posts: { id: Uuid; apId: string }[];
  pendingDeliveries: { id: Uuid; activityApId: string; inboxUrl: string }[];
};

/** JSON with object keys sorted, so the same facts always give the same bytes (and digest). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const manifestDigest = (manifest: Manifest): string => createHash('sha256').update(canonicalJson(manifest)).digest('hex');

/** Reads the facts inside the caller's transaction, so the manifest matches the state change it records. */
export async function buildManifest(q: Queryable, mediaId: Uuid, verdict: Verdict, now: Date): Promise<Manifest> {
  const [row] = await q.select().from(media).where(eq(media.id, mediaId));
  if (!row) throw new Error(`manifest: no media ${mediaId}`);
  const [owner] = row.ownerId ? await q.select({ apId: actors.apId }).from(actors).where(eq(actors.id, row.ownerId)) : [];
  return {
    v: 1,
    mediaId,
    sha256: row.sha256,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    storageKey: row.storageKey,
    uploadedAt: row.createdAt.toISOString(),
    quarantinedAt: now.toISOString(),
    uploader: row.ownerId && owner ? { actorId: row.ownerId, apId: owner.apId } : null,
    verdict,
    posts: await postsNaming(q, mediaId),
    pendingDeliveries: await pendingDeliveriesNaming(q, mediaId),
  };
}
