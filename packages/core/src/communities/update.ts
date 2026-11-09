import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { asc, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { vanished } from '../moderation/shared.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { markdown, replaceLanguages, replaceRules } from './fields.ts';
import type { WriteTx } from '../db/write.ts';
import { CommunityInput, type CommunityFields, type CommunityPatch } from './input.ts';
import { communityRules } from './tables.ts';

/**
 * Edits a local community with a patch: a field that is present replaces the stored value,
 * one that is absent stays (the name never changes). The policy locked the community's actor
 * row, which this updates, so two edits take turns. actor.updated with kind 'Group' is what
 * federation turns into Update(Group). A modlog row (action community.update) names whoever
 * edited, owner, moderator or admin, with `details.fields` naming the fields whose stored value
 * changed (an edit form sends every field, so a field is listed only when it differs). Not safe for life implies the age gate, whichever of the
 * two the patch names, so the stored pair is read first.
 */
export const updateCommunity = defineMutation({
  action: 'community.update',
  emits: ['actor.updated'],
  recheck: true,
  async run(t, grant, input: CommunityPatch) {
    const patch = CommunityInput.assert(input);
    const { communityId } = grant.subject;
    const [current] = await t.db
      .select({
        apId: actors.apId,
        displayName: actors.displayName,
        summaryMd: actors.summaryMd,
        sensitive: actors.sensitive,
        nsfl: actors.nsfl,
        postingRestrictedToMods: actors.postingRestrictedToMods,
        postingWarning: actors.postingWarning,
        discoverable: actors.discoverable,
        indexable: actors.indexable,
      })
      .from(actors)
      .where(eq(actors.id, communityId))
      .for('no key update');
    if (!current) throw vanished(`community ${communityId}`);
    const { origin } = await localInstance(t.db);
    const nsfl = patch.nsfl ?? current.nsfl;
    const set: Partial<typeof actors.$inferInsert> = {
      updatedAt: new Date(),
      nsfl,
      sensitive: (patch.sensitive ?? current.sensitive) || nsfl,
    };
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.description !== undefined) {
      const summary = markdown(patch.description, origin);
      set.summaryMd = summary.md;
      set.summaryHtml = summary.html;
    }
    if (patch.postingRestrictedToMods !== undefined) set.postingRestrictedToMods = patch.postingRestrictedToMods;
    if (patch.postingWarning !== undefined) set.postingWarning = patch.postingWarning || null;
    if (patch.discoverable !== undefined) set.discoverable = patch.discoverable;
    if (patch.indexable !== undefined) set.indexable = patch.indexable;
    const fields = await changedFields(t.db, communityId, current, set, patch);
    await t.db.update(actors).set(set).where(eq(actors.id, communityId));
    if (patch.languages) await replaceLanguages(t.db, communityId, patch.languages);
    if (patch.rules) await replaceRules(t.db, communityId, origin, patch.rules);
    await writeModlog(t.db, grant, {
      community: { id: communityId, apId: current.apId },
      target: null,
      reason: null,
      details: { fields },
    });
    await t.emit({ type: 'actor.updated', v: 1, actorId: communityId, kind: 'Group', local: true });
  },
});

const columnFields = [
  'displayName',
  'sensitive',
  'nsfl',
  'postingRestrictedToMods',
  'postingWarning',
  'discoverable',
  'indexable',
] as const;

/** The names of the fields the patch changes, compared with what is stored before the write. */
async function changedFields(
  db: WriteTx,
  communityId: Uuid,
  current: Pick<typeof actors.$inferSelect, 'summaryMd' | (typeof columnFields)[number]>,
  set: Partial<typeof actors.$inferInsert>,
  patch: CommunityFields,
): Promise<string[]> {
  const fields: string[] = columnFields.filter((field) => field in set && set[field] !== current[field]);
  if (patch.description !== undefined && (patch.description || null) !== current.summaryMd) fields.push('description');
  if (patch.languages) {
    const stored = await db
      .select({ language: communityLanguages.language })
      .from(communityLanguages)
      .where(eq(communityLanguages.communityId, communityId));
    const same = new Set(stored.map((row) => row.language));
    const next = new Set(patch.languages);
    if (same.size !== next.size || [...next].some((language) => !same.has(language))) fields.push('languages');
  }
  if (patch.rules) {
    const stored = await db
      .select({ title: communityRules.title, bodyMd: communityRules.bodyMd })
      .from(communityRules)
      .where(eq(communityRules.communityId, communityId))
      .orderBy(asc(communityRules.position));
    const next = patch.rules.map((rule) => ({ title: rule.title, bodyMd: rule.body || null }));
    if (JSON.stringify(stored) !== JSON.stringify(next)) fields.push('rules');
  }
  return fields;
}

/** community.update for web: the owner, a moderator or an admin edits `communityId`. */
export async function updateCommunityAs(principal: Principal, communityId: Uuid, patch: CommunityPatch): Promise<Result<object>> {
  const decision = await authorize('community.update', principal, { communityId });
  if (!decision.ok) return decision;
  if (CommunityInput(patch) instanceof type.errors) return { ok: false, reason: 'community.invalid' };
  return refusedAsResult(async () => {
    await updateCommunity(decision.grant, patch);
    return {};
  });
}
