import type { Uuid } from '@peblish/schema/ids';
import type { Handle, InviteLookup, InviteRow } from '@peblish/schema/invite';
import { aliasedTable, and, desc, eq, inArray, sql } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { inviteUses, invites } from '../db/tables/site.ts';
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

/** name and name@host, the way the mocks show local people. */
async function handles() {
  const { origin } = await localInstance(db());
  const host = new URL(origin).host;
  return { host, handle: (name: string): Handle => ({ name, handle: `${name}@${host}` }) };
}

/** What a code would do now, without using it (the invite landing page and the sign-up form). */
export async function lookupInvite(code: string): Promise<InviteLookup> {
  const { handle } = await handles();
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
  const { handle } = await handles();
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

/**
 * The local person a handle names: name, @name or @name@host for this host. Null for anyone
 * else, a remote handle included.
 */
export async function findLocalPerson(input: string): Promise<{ id: Uuid; name: string } | null> {
  const { host } = await handles();
  const [name, at] = input.trim().replace(/^@/, '').split('@');
  if (!name || (at !== undefined && at.toLowerCase() !== host.toLowerCase())) return null;
  const [actor] = await db()
    .select({ id: actors.id, name: actors.name })
    .from(actors)
    .where(and(eq(actors.local, true), eq(actors.kind, 'Person'), sql`lower(${actors.name}) = ${name.toLowerCase()}`));
  return actor ?? null;
}
