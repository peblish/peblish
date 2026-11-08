import type { ActingPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { InviteLookup, InviteRow } from '@peblish/schema/invite';
import { aliasedTable, desc, eq, inArray, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { inviteUses, invites } from '../db/tables/site.ts';
import { localHandles } from '../identity/handles.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { defineMutation } from '../tx/mutation.ts';
import { inviteCodeHash, inviteStatus, newInviteCode } from './codes.ts';

/**
 * A new invite from the referrer in grant.subject (the chain's parent, stored as created_by).
 * The code is returned once and only its hash is kept.
 */
export const createInvite = defineMutation({
  action: 'invite.create',
  emits: ['invite.created'],
  // A demotion, or the referrer's deletion, can land after authorize().
  recheck: true,
  async run(t, grant, input: { label: string | null; maxUses: number; expiresAt: Date | null }) {
    const code = newInviteCode();
    const [row] = await t.db
      .insert(invites)
      .values({
        codeHash: inviteCodeHash(code),
        createdBy: grant.subject.referrerId,
        maxUses: input.maxUses,
        note: input.label,
        expiresAt: input.expiresAt,
      })
      .returning({ id: invites.id });
    if (!row) throw new Error('invite insert returned nothing');
    await t.emit({ type: 'invite.created', v: 1, inviteId: row.id, referrerId: grant.subject.referrerId, adminId: grant.actorId });
    return { id: row.id, code };
  },
});

export const revokeInvite = defineMutation({
  action: 'invite.revoke',
  emits: ['invite.revoked'],
  recheck: true,
  async run(t, grant) {
    const { inviteId } = grant.subject;
    await t.db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, inviteId));
    await t.emit({ type: 'invite.revoked', v: 1, inviteId, adminId: grant.actorId });
  },
});

/** What a code would do now, without using it (the invite landing page and the sign-up form). */
export async function lookupInvite(code: string): Promise<InviteLookup> {
  const { handle } = await localHandles();
  const [row] = await db()
    .select({
      maxUses: invites.maxUses,
      useCount: invites.useCount,
      expiresAt: invites.expiresAt,
      revokedAt: invites.revokedAt,
      inviter: actors.name,
    })
    .from(invites)
    .leftJoin(actors, eq(actors.id, invites.createdBy))
    .where(eq(invites.codeHash, inviteCodeHash(code)));
  if (!row) return { status: 'unknown', inviter: null, usesLeft: 0, maxUses: 0, expiresAt: null };
  return {
    status: inviteStatus(row),
    inviter: row.inviter === null ? null : handle(row.inviter),
    usesLeft: Math.max(0, row.maxUses - row.useCount),
    maxUses: row.maxUses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** Every invite, newest first, with who used it (the admin invites table). */
export async function listInvites(): Promise<InviteRow[]> {
  const { handle } = await localHandles();
  const referrer = aliasedTable(actors, 'referrer');
  const rows = await db()
    .select({
      id: invites.id,
      label: invites.note,
      referrer: referrer.name,
      useCount: invites.useCount,
      maxUses: invites.maxUses,
      expiresAt: invites.expiresAt,
      revokedAt: invites.revokedAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .leftJoin(referrer, eq(referrer.id, invites.createdBy))
    .orderBy(desc(invites.createdAt));
  const ids = rows.map(({ id }) => id);
  const uses =
    ids.length === 0
      ? []
      : await db()
          .select({
            inviteId: inviteUses.inviteId,
            name: actors.name,
            usedAt: inviteUses.usedAt,
            emailVerified: sql<boolean>`coalesce(${authUser.emailVerified}, false)`,
            deletedAt: actors.deletedAt,
          })
          .from(inviteUses)
          .innerJoin(actors, eq(actors.id, inviteUses.actorId))
          .leftJoin(authUser, eq(authUser.id, actors.userId))
          .where(inArray(inviteUses.inviteId, ids))
          .orderBy(inviteUses.usedAt);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    referrer: row.referrer === null ? null : handle(row.referrer),
    uses: row.useCount,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    status: inviteStatus(row),
    createdAt: row.createdAt.toISOString(),
    usedBy: uses
      .filter((use) => use.inviteId === row.id)
      .map((use) => ({
        ...handle(use.name),
        usedAt: use.usedAt.toISOString(),
        emailVerified: use.emailVerified,
        deleted: use.deletedAt !== null,
      })),
  }));
}

/** invite.create for web: authorize as `principal`, then create; the code comes back once. */
export async function createInviteAs(
  principal: ActingPrincipal,
  input: { referrerId: Uuid; label: string | null; maxUses: number; expiresAt: Date | null },
): Promise<Result<{ id: Uuid; code: string }>> {
  const decision = await authorize('invite.create', principal, { referrerId: input.referrerId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => createInvite(decision.grant, input));
}

/** invite.revoke for web. */
export async function revokeInviteAs(principal: ActingPrincipal, inviteId: Uuid): Promise<Result<object>> {
  const decision = await authorize('invite.revoke', principal, { inviteId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    await revokeInvite(decision.grant, undefined);
    return {};
  });
}
