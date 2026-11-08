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
 * Deletes an account at once (no grace period; A05, decision recorded in LANE-NOTES.md).
 * The actor row stays with its ap_id, keys and content, so the modlog, the invite chain and
 * FED-B's Delete keep naming it; its profile fields are scrubbed and deleted_at set. The
 * better-auth user goes, which revokes every session and removes the email and password
 * (actors.user_id becomes null). The deletion ledger records it for re-application after a
 * backup restore, and actor.deleted is emitted, all in this one transaction.
 *
 * No recheck: nothing a moderator does revokes a deletion. The body locks the actor row and
 * checks it is still a live local person, so two deletions cannot both apply.
 */
export const deleteAccount = defineMutation({
  action: 'account.delete',
  emits: ['actor.deleted'],
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

/** account.delete for web: the owner (or an admin) deletes the account of `actorId`. */
export async function deleteAccountAs(principal: ActingPrincipal, actorId: Uuid, reason: string): Promise<Result<object>> {
  const decision = await authorize('account.delete', principal, { actorId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    await deleteAccount(decision.grant, { reason });
    return {};
  });
}
