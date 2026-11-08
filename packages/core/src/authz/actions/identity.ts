import { RESERVED_NAMES, Email, MINIMUM_AGE } from '@peblish/schema/identity';
import { ACTOR_NAME } from '@peblish/schema/actor-urls';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/read.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { invites } from '../../db/tables/site.ts';
import { inviteCodeHash, inviteRefusal, inviteStatus } from '../../registration/codes.ts';
import { accountCount, registrationSettings } from '../../registration/settings.ts';
import type { Frozen } from '../frozen.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane A: accounts and invites (A01, A05, M20). Under lock (PolicyRequest.lock), the
// actor row account.delete updates is read FOR NO KEY UPDATE. invite.create's referrer is read
// FOR SHARE: its body only inserts a reference to it, and the referrer is usually the admin,
// whose row the principal refresh already holds FOR SHARE. Upgrading that lock would deadlock
// two invite.create calls by one admin; FOR SHARE still makes a deletion wait for the write.

/** Serialises account creation under lock, so two sign-ups cannot both take the last cap slot. */
const accountsLock = sql`select pg_advisory_xact_lock(hashtext('peblish.accounts'))`;

/**
 * A site admin with two-factor on (A03: TOTP is mandatory for admins). Returns the deny, or
 * null when the principal qualifies.
 */
async function denyUnlessAdmin(principal: Frozen<ActingPrincipal>, db: Queryable, lock: boolean): Promise<PolicyResult | null> {
  if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
  const [admin] = await forShare(
    db
      .select({ role: authUser.role, twoFactorEnabled: authUser.twoFactorEnabled })
      .from(actors)
      .innerJoin(authUser, eq(authUser.id, actors.userId))
      .where(eq(actors.id, principal.actorId)),
    lock,
  );
  if (admin?.role !== 'admin') return deny('auth.admin_required');
  if (!admin.twoFactorEnabled) return deny('admin.two_factor_required');
  return null;
}

/** Whether a new account may take `name` and `email`: valid, not reserved, not taken. */
async function newAccountProblem(db: Queryable, name: string, email: string): Promise<RefusalReason | null> {
  if (!ACTOR_NAME.test(name)) return 'name.invalid';
  if (RESERVED_NAMES.has(name.toLowerCase())) return 'name.reserved';
  if (!Email.allows(email)) return 'email.invalid';
  const [named] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.local, true), sql`lower(${actors.name}) = ${name.toLowerCase()}`));
  if (named) return 'name.taken';
  const [user] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
  if (user) return 'email.taken';
  return null;
}

type Registration = { inviteCode: string; name: string; email: string; age: number | null };

export const policies = {
  /**
   * The instance registers a person (system principal, job registration): sign-up open, a
   * 16+ declaration, a usable invite (its row locked: the body counts the use), the cap
   * not reached, and a free, valid name and email. The authority's ref is the invite id.
   */
  'account.register': async ({ principal, subject, db, lock }: PolicyRequest<Registration>) => {
    if (principal.kind !== 'system' || principal.job !== 'registration') return deny('auth.required');
    const settings = await registrationSettings(db, lock);
    if (!settings.enabled) return deny('site.disabled');
    if (subject.age === null) return deny('age.declaration_required');
    if (subject.age < MINIMUM_AGE) return deny('age.under_16');
    const [invite] = await forNoKeyUpdate(
      db
        .select({
          id: invites.id,
          maxUses: invites.maxUses,
          useCount: invites.useCount,
          expiresAt: invites.expiresAt,
          revokedAt: invites.revokedAt,
        })
        .from(invites)
        .where(eq(invites.codeHash, inviteCodeHash(subject.inviteCode))),
      lock,
    );
    const status = inviteStatus(invite);
    if (!invite || status !== 'valid') return deny(inviteRefusal[status === 'valid' ? 'unknown' : status]);
    if (lock) await db.execute(accountsLock);
    if ((await accountCount(db)) >= settings.cap) return deny('registration.capped');
    const problem = await newAccountProblem(db, subject.name, subject.email);
    if (problem) return deny(problem);
    return allow({ kind: 'system', actorId: principal.actorId, job: 'registration', ref: invite.id });
  },

  /** The first admin, from the command line (identity/admin-cli.ts): only while there is none. */
  'account.bootstrap_admin': async ({ principal, subject, db, lock }: PolicyRequest<{ name: string; email: string }>) => {
    if (principal.kind !== 'system' || principal.job !== 'registration') return deny('auth.required');
    if (lock) await db.execute(accountsLock);
    const [admin] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.role, 'admin'));
    if (admin) return deny('admin.exists');
    const problem = await newAccountProblem(db, subject.name, subject.email);
    if (problem) return deny(problem);
    return allow({ kind: 'system', actorId: principal.actorId, job: 'registration', ref: null });
  },

  /**
   * A person deletes their own account, or a site admin deletes someone else's (not another
   * admin's). The body updates the actor row and deletes the login, so both are read FOR NO
   * KEY UPDATE under lock; for your own account, deleteAccount already holds the actor row.
   */
  'account.delete': async ({ principal, subject, db, lock }: PolicyRequest<{ actorId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const [target] = await forNoKeyUpdate(
      db
        .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt, userId: actors.userId })
        .from(actors)
        .where(eq(actors.id, subject.actorId)),
      lock,
    );
    if (!target?.local || target.kind !== 'Person') return deny('target.not_found');
    if (target.deletedAt) return deny('target.deleted');
    // An imported person without a login has no account to delete.
    if (!target.userId) return deny('target.not_found');
    if (principal.actorId === subject.actorId) return allow({ kind: 'owner', actorId: principal.actorId });
    const denied = await denyUnlessAdmin(principal, db, lock);
    if (denied) return denied;
    const [login] = await forNoKeyUpdate(db.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, target.userId)), lock);
    if (login?.role === 'admin') return deny('target.protected');
    return allow({ kind: 'site-admin', actorId: principal.actorId });
  },

  /** An admin makes an invite on behalf of a referrer: a local person who still exists. */
  'invite.create': async ({ principal, subject, db, lock }: PolicyRequest<{ referrerId: Uuid }>) => {
    const denied = await denyUnlessAdmin(principal, db, lock);
    if (denied) return denied;
    const [referrer] = await forShare(
      db
        .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt })
        .from(actors)
        .where(eq(actors.id, subject.referrerId)),
      lock,
    );
    if (!referrer?.local || referrer.kind !== 'Person') return deny('target.not_found');
    if (referrer.deletedAt) return deny('target.deleted');
    return allow({ kind: 'site-admin', actorId: principal.actorId });
  },

  'invite.revoke': async ({ principal, subject, db, lock }: PolicyRequest<{ inviteId: Uuid }>) => {
    const denied = await denyUnlessAdmin(principal, db, lock);
    if (denied) return denied;
    const [invite] = await forNoKeyUpdate(
      db.select({ revokedAt: invites.revokedAt }).from(invites).where(eq(invites.id, subject.inviteId)),
      lock,
    );
    if (!invite) return deny('target.not_found');
    if (invite.revokedAt) return deny('invite.revoked');
    return allow({ kind: 'site-admin', actorId: principal.actorId });
  },
};
