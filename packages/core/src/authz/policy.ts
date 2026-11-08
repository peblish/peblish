import type { ActingPrincipal, Authority } from '@peblish/schema/authz';
import type { RefusalReason } from '@peblish/schema/refusal';
import type { AssertNever, Overlap } from '@peblish/schema/registry';
import type { Queryable } from '../db/read.ts';
import type { policies, policyAreas } from '../registry/policies.gen.ts';
import type { Frozen } from './frozen.ts';

// Owned by lane AZ after G0. A policy decides one action. Policies are registered by glob
// from authz/actions/<area>.ts (each exports `policies`, owned by the area's lane); the
// action catalogue is the union of their keys.

export type PolicyResult = { ok: true; authority: Authority } | { ok: false; reason: RefusalReason };

export type PolicyRequest<S> = {
  /** Frozen snapshots taken before the policy runs; the grant stores the same objects. */
  principal: Frozen<ActingPrincipal>;
  /** What the action applies to; the grant carries it so a service cannot swap targets. */
  subject: Frozen<S>;
  /** Read inside the caller's transaction when one is open, else the read pool. */
  db: Queryable;
  /**
   * True when the policy runs inside the writing transaction (a mutation's recheck). Every
   * row the decision rests on is then read locked, so a revocation that updates an existing
   * row (a soft delete, a demotion, a lock flag) either committed first and the recheck sees
   * it, or waits until this write commits:
   * - forShare(query, lock) for rows no write body updates;
   * - forNoKeyUpdate(query, lock) for any row a write body updates (a counter, a vote tally,
   *   a ban target). Reading such a row FOR SHARE and updating it later deadlocks two
   *   concurrent writers (40P01), so every policy that reads it uses forNoKeyUpdate; mixing
   *   the two modes on one row can still deadlock.
   * A lock on a query that finds no row locks nothing. So a revocation recorded as an INSERT
   * (a ban, a lock row, a removal marker) first takes FOR NO KEY UPDATE, in its own mutation,
   * on the parent row the policies lock: the community actor row, or the target actor row
   * for a site ban (the principal refresh locks the acting actor's row). Each policy it
   * revokes locks that same parent row.
   */
  lock: boolean;
};

export type Policy<S> = (request: PolicyRequest<S>) => Promise<PolicyResult>;

type Policies = typeof policies;
export type ActionName = keyof Policies;
export type SubjectOf<A extends ActionName> = Parameters<Policies[A]>[0]['subject'];

export type DuplicateActions = AssertNever<Overlap<typeof policyAreas>>;

export const allow = (authority: Authority): PolicyResult => ({ ok: true, authority });
export const deny = (reason: RefusalReason): PolicyResult => ({ ok: false, reason });

/** A Drizzle select that can take a row lock. */
type Lockable<R> = PromiseLike<R> & { for(strength: 'share' | 'no key update'): PromiseLike<R> };

/** FOR SHARE on an authorization read when the policy runs with `lock`: rows no write body updates. */
export function forShare<R>(query: Lockable<R>, lock: boolean): PromiseLike<R> {
  return lock ? query.for('share') : query;
}

/**
 * FOR NO KEY UPDATE on an authorization read when the policy runs with `lock`: rows a write
 * body updates, and the parent rows an INSERT-recorded revocation locks (see PolicyRequest.lock).
 * It still lets inserts that reference the row (their foreign-key checks) through.
 */
export function forNoKeyUpdate<R>(query: Lockable<R>, lock: boolean): PromiseLike<R> {
  return lock ? query.for('no key update') : query;
}
