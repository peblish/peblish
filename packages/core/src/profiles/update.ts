import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { markdown } from '../communities/fields.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { defineMutation } from '../tx/mutation.ts';
import { ProfileInput, type ProfilePatch } from './input.ts';

/**
 * Edits the acting person's display name and bio. A field that is present replaces the stored
 * value (empty clears it), one that is absent stays. actor.updated with kind 'Person' is what
 * federation sends as Update(Person); it is emitted only when something changed. The bio is
 * stored as Markdown source and as the federation form of its HTML. The recheck refuses a
 * person site-banned or deleted since authorize() (auth.site_banned, auth.actor_deleted).
 */
const updateProfileRow = defineMutation({
  action: 'profile.update',
  emits: ['actor.updated'],
  recheck: true,
  async run(t, grant, input: ProfilePatch) {
    const patch = ProfileInput.assert(input);
    const { actorId } = grant.subject;
    const [current] = await t.db
      .select({ displayName: actors.displayName, summaryMd: actors.summaryMd })
      .from(actors)
      .where(eq(actors.id, actorId))
      .for('no key update');
    if (!current) throw new Error(`profile ${actorId} vanished after authorization`);
    const displayName = patch.displayName === undefined ? current.displayName : patch.displayName || null;
    const bio = patch.bio === undefined ? current.summaryMd : patch.bio || null;
    if (displayName === current.displayName && bio === current.summaryMd) return { changed: false };
    const { origin } = await localInstance(t.db);
    const summary = markdown(bio, origin);
    await t.db
      .update(actors)
      .set({ displayName, summaryMd: summary.md, summaryHtml: summary.html, updatedAt: new Date() })
      .where(eq(actors.id, actorId));
    await t.emit({ type: 'actor.updated', v: 1, actorId, kind: 'Person', local: true });
    return { changed: true };
  },
});

/**
 * profile.update in its own transaction (updateProfileRow, rechecked). The body updates the
 * acting person's own actor row, which the recheck's principal refresh reads FOR SHARE, so two
 * edits at once (a double submit) would each hold it FOR SHARE and wait for the other to
 * upgrade (40P01). The row is locked FOR NO KEY UPDATE first, as deleteAccount does: a second
 * edit, or a site ban (which locks the same row before inserting), waits here, and the recheck
 * then sees whatever committed first.
 */
export const updateProfile = defineMutation({
  action: 'profile.update',
  emits: ['actor.updated'],
  async run(t, grant, input: ProfilePatch) {
    await t.db.select({ id: actors.id }).from(actors).where(eq(actors.id, grant.actorId)).for('no key update');
    return updateProfileRow.within(t, grant, input);
  },
});

/** profile.update for web: the person edits their own profile. `changed` is false when nothing differs. */
export async function updateProfileAs(principal: Principal, actorId: Uuid, patch: ProfilePatch): Promise<Result<{ changed: boolean }>> {
  const decision = await authorize('profile.update', principal, { actorId });
  if (!decision.ok) return decision;
  if (ProfileInput(patch) instanceof type.errors) return { ok: false, reason: 'profile.invalid' };
  return refusedAsResult(() => updateProfile(decision.grant, patch));
}
