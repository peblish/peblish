import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNull } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { media } from '../db/tables/media.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { findBlocked, sha256Pattern } from './blocklist.ts';
import { quarantine } from './quarantine.ts';
import { mediaBlocklist } from './tables.ts';

// Owned by lane SAFE. The blocked-image list, edited by an admin.

export type BlockCategory = typeof mediaBlocklist.$inferInsert.category;
export const blockCategories = ['csam', 'intimate_image', 'violent', 'spam', 'other'] as const satisfies readonly BlockCategory[];

/**
 * Adds an exact SHA-256 to the list and quarantines every clean, undeleted copy already stored,
 * each with its own evidence row (the list is the verdict). Pending copies are caught by their
 * scan; an upload with this hash is quarantined with no provider call. Returns how many clean
 * images it quarantined.
 */
export const addBlockedHash = defineMutation({
  action: 'media.blocklist',
  emits: ['media.blocklist_changed', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { value: string; category: BlockCategory; reason?: string | null; now: Date }) {
    const value = input.value.trim().toLowerCase();
    if (!sha256Pattern.test(value)) throw new Refused('media.blocklist', 'media.hash_invalid');
    if (await findBlocked(t.db, value)) throw new Refused('media.blocklist', 'media.hash_exists');
    const [entry] = await t.db
      .insert(mediaBlocklist)
      .values({
        kind: 'sha256',
        value,
        category: input.category,
        reason: input.reason?.trim().slice(0, 500) || null,
        addedBy: grant.actorId,
      })
      .returning();
    if (!entry) throw new Error('list entry not written');
    // Clean copies, locked as the scan and review writes lock them (media row, FOR NO KEY UPDATE).
    const copies = await t.db
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.sha256, value), eq(media.scanState, 'clean'), isNull(media.deletedAt)))
      .for('no key update');
    for (const copy of copies)
      await quarantine(t, {
        action: 'media.blocklist',
        mediaId: copy.id,
        from: 'clean',
        verdict: { source: 'list', entryId: entry.id, category: entry.category, listedAt: entry.createdAt.toISOString() },
        now: input.now,
      });
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({
      type: 'media.blocklist_changed',
      v: 1,
      entryId: entry.id,
      adminId: grant.actorId,
      change: 'added',
      quarantined: copies.length,
    });
    return { entryId: entry.id, quarantined: copies.length };
  },
});

/** Removes an entry. Images already quarantined or blocked under it stay as they are; only later uploads are no longer matched by it. */
export const removeBlockedHash = defineMutation({
  action: 'media.blocklist',
  emits: ['media.blocklist_changed'],
  recheck: true,
  async run(t, grant, _input: Record<string, never>) {
    const { entryId } = grant.subject;
    if (entryId === null) throw new Refused('media.blocklist', 'target.not_found');
    const removed = await t.db.delete(mediaBlocklist).where(eq(mediaBlocklist.id, entryId)).returning({ id: mediaBlocklist.id });
    if (removed.length === 0) throw new Refused('media.blocklist', 'target.not_found');
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({ type: 'media.blocklist_changed', v: 1, entryId, adminId: grant.actorId, change: 'removed', quarantined: 0 });
    return {};
  },
});

export async function addToBlocklist(
  principal: Principal,
  input: { value: string; category: BlockCategory; reason?: string | null },
  now = new Date(),
): Promise<Result<{ entryId: Uuid; quarantined: number }>> {
  const decision = await authorize('media.blocklist', principal, { entryId: null });
  if (!decision.ok) return decision;
  return refusedAsResult(() => addBlockedHash(decision.grant, { ...input, now }));
}

export async function removeFromBlocklist(principal: Principal, entryId: Uuid): Promise<Result<object>> {
  const decision = await authorize('media.blocklist', principal, { entryId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeBlockedHash(decision.grant, {}));
}
