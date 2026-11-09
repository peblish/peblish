import type { ActingPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { refusedAsResult, type Result } from './result.ts';

/**
 * Deletes an account at once (no grace period; A05, decision 6 in lane A's wave 1 notes).
 * The actor row stays with its ap_id, keys and content, so the modlog, the invite chain and
 * FED-B's Delete keep naming it; its profile fields are scrubbed and deleted_at set. The
 * better-auth user goes, which revokes every session and removes the email and password
 * (actors.user_id becomes null). The deletion ledger records it for re-application after a
 * backup restore, and actor.deleted is emitted, all in this one transaction.
 *
 * The recheck re-reads the principal, so a site admin's grant does not outlive a demotion or
 * two-factor turned off after authorize(). The body locks the actor row and checks it is
 * still a live local person, so two deletions cannot both apply.
 */
const deleteAccountRow = defineMutation({
  action: 'account.delete',
  emits: ['actor.deleted'],
  recheck: true,
  async run(t, grant, input: { reason: string }) {
    const { actorId } = grant.subject;
    const [actor] = await t.db
      .select({ apId: actors.apId, userId: actors.userId, deletedAt: actors.deletedAt })
      .from(actors)
      .where(eq(actors.id, actorId))
      .for('no key update');
    if (!actor) throw new Refused('account.delete', 'target.not_found');
    if (actor.deletedAt || !actor.userId) throw new Refused('account.delete', 'target.deleted');
    const now = new Date();
    await t.db
      .update(actors)
      .set({ displayName: null, summaryHtml: null, summaryMd: null, iconUrl: null, bannerUrl: null, deletedAt: now, updatedAt: now })
      .where(eq(actors.id, actorId));
    await t.db.delete(authUser).where(eq(authUser.id, actor.userId));
    await t.db.insert(deletionLedger).values({
      subjectKind: 'actor',
      subjectId: actorId,
      subjectApId: actor.apId,
      reason: input.reason,
      requestedBy: grant.actorId,
      details: { userId: actor.userId, authority: grant.authority.kind },
    });
    await t.emit({ type: 'actor.deleted', v: 1, actorId, kind: 'Person', local: true });
  },
});

/**
 * account.delete in its own transaction (deleteAccountRow, rechecked). Deleting your own
 * account updates the acting actor's row, which the recheck's principal refresh reads FOR
 * SHARE: two such requests at once (a double submit) would both hold it FOR SHARE and each
 * wait for the other before updating it (40P01). So the owner's row is locked FOR NO KEY
 * UPDATE first, before the recheck: a second request waits here, then its recheck finds the
 * actor deleted and refuses with auth.actor_deleted. An admin deleting someone else locks the
 * target in the policy, after its own row, as the lock order says.
 */
export const deleteAccount = defineMutation({
  action: 'account.delete',
  emits: ['actor.deleted'],
  async run(t, grant, input: { reason: string }) {
    if (grant.subject.actorId === grant.actorId)
      await t.db.select({ id: actors.id }).from(actors).where(eq(actors.id, grant.actorId)).for('no key update');
    return deleteAccountRow.within(t, grant, input);
  },
});

/** account.delete for web: the owner (or an admin) deletes the account of `actorId`. */
export async function deleteAccountAs(principal: ActingPrincipal, actorId: Uuid, reason: string): Promise<Result<object>> {
  const decision = await authorize('account.delete', principal, { actorId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    await deleteAccount(decision.grant, { reason });
    return {};
  });
}
