import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { listBlockedHash } from './block.ts';
import { findBlocked, sha256Pattern } from './blocklist.ts';
import { lockHash } from './hash-lock.ts';
import { mediaBlocklist } from './tables.ts';

// Owned by lane SAFE. The blocked-image list, edited by an admin.

export type BlockCategory = typeof mediaBlocklist.$inferInsert.category;
export const blockCategories = ['csam', 'intimate_image', 'violent', 'spam', 'other'] as const satisfies readonly BlockCategory[];

/**
 * Adds an exact SHA-256 to the list and quarantines every clean, undeleted copy already stored,
 * each with its own evidence row (the list is the verdict). Pending copies are caught by their
 * scan; an upload with this hash is quarantined with no provider call. Returns how many clean
 * images it quarantined. A `media.hash_added` deletion_ledger row (subject: the list entry)
 * makes a backup restore list the hash again and quarantine its copies (tools/cutover drill.ts).
 */
export const addBlockedHash = defineMutation({
  action: 'media.blocklist',
  emits: ['media.blocklist_changed', 'media.quarantined'],
  recheck: true,
  async run(t, grant, input: { value: string; category: BlockCategory; reason?: string | null; now: Date }) {
    const value = input.value.trim().toLowerCase();
    if (!sha256Pattern.test(value)) throw new Refused('media.blocklist', 'media.hash_invalid');
    // Under the hash lock, so a scan of a copy records either before this (and the copy is found
    // clean below) or after it (and its own recheck finds the entry): hash-lock.ts.
    await lockHash(t.db, value);
    if (await findBlocked(t.db, value)) throw new Refused('media.blocklist', 'media.hash_exists');
    const reason = input.reason?.trim().slice(0, 500) || null;
    const { entryId, quarantinedCopies } = await listBlockedHash(t, {
      action: 'media.blocklist',
      sha256: value,
      category: input.category,
      reason,
      by: grant.actorId,
      now: input.now,
    });
    await t.db.insert(deletionLedger).values({
      subjectKind: 'media',
      subjectId: entryId,
      reason: 'media.hash_added',
      requestedBy: grant.actorId,
      details: { sha256: value, category: input.category, reason },
    });
    await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false } });
    await t.emit({
      type: 'media.blocklist_changed',
      v: 1,
      entryId,
      adminId: grant.actorId,
      change: 'added',
      quarantined: quarantinedCopies,
    });
    return { entryId, quarantined: quarantinedCopies };
  },
});

/**
 * Removes an entry. Images already quarantined or blocked under it stay as they are; only later
 * uploads are no longer matched by it. A `media.hash_removed` deletion_ledger row makes a backup
 * restore take the hash off the list again, after any earlier row that listed it.
 */
export const removeBlockedHash = defineMutation({
  action: 'media.blocklist',
  emits: ['media.blocklist_changed'],
  recheck: true,
  async run(t, grant, _input: Record<string, never>) {
    const { entryId } = grant.subject;
    if (entryId === null) throw new Refused('media.blocklist', 'target.not_found');
    const [removed] = await t.db.delete(mediaBlocklist).where(eq(mediaBlocklist.id, entryId)).returning({ value: mediaBlocklist.value });
    if (!removed) throw new Refused('media.blocklist', 'target.not_found');
    await t.db.insert(deletionLedger).values({
      subjectKind: 'media',
      subjectId: entryId,
      reason: 'media.hash_removed',
      requestedBy: grant.actorId,
      details: { sha256: removed.value },
    });
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
