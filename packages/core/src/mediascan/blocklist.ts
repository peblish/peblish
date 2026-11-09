import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { mediaBlocklist } from './tables.ts';

/** The list entry for an image's exact SHA-256 (lowercase hex), if any. */
export async function findBlocked(q: Queryable, sha256: string) {
  const [entry] = await q
    .select({ id: mediaBlocklist.id, category: mediaBlocklist.category, createdAt: mediaBlocklist.createdAt })
    .from(mediaBlocklist)
    .where(and(eq(mediaBlocklist.kind, 'sha256'), eq(mediaBlocklist.value, sha256)));
  return entry ?? null;
}

export const sha256Pattern = /^[0-9a-f]{64}$/;
