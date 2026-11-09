import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { vanished } from '../moderation/shared.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { markdown, replaceLanguages, replaceRules } from './fields.ts';
import { CommunityInput, type CommunityPatch } from './input.ts';

/**
 * Edits a local community with a patch: a field that is present replaces the stored value,
 * one that is absent stays (the name never changes). The policy locked the community's actor
 * row, which this updates, so two edits take turns. actor.updated with kind 'Group' is what
 * federation turns into Update(Group). A modlog row (action community.update) names whoever
 * edited, owner, moderator or admin. Not safe for life implies the age gate, whichever of the
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
      .select({ apId: actors.apId, sensitive: actors.sensitive, nsfl: actors.nsfl })
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
    await t.db.update(actors).set(set).where(eq(actors.id, communityId));
    if (patch.languages) await replaceLanguages(t.db, communityId, patch.languages);
    if (patch.rules) await replaceRules(t.db, communityId, origin, patch.rules);
    await writeModlog(t.db, grant, { community: { id: communityId, apId: current.apId }, target: null, reason: null });
    await t.emit({ type: 'actor.updated', v: 1, actorId: communityId, kind: 'Group', local: true });
  },
});

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
