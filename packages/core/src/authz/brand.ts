import type { ActingPrincipal, Authority } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { ActionName, SubjectOf } from './policy.ts';

let issue: <A extends ActionName>(action: A, principal: ActingPrincipal, subject: SubjectOf<A>, authority: Authority) => Authorized<A>;

/**
 * Proof that authorize() allowed `action` on `subject` for `principal`. Every core write
 * service takes one, so an unauthorized write does not compile (the private field makes the
 * class nominal: no object literal or cast-free value of another type satisfies it). Only
 * authorize.ts creates grants (lint rule authz-brand); mutations re-check at runtime.
 */
export class Authorized<A extends ActionName> {
  readonly #genuine = true;
  readonly action: A;
  readonly principal: ActingPrincipal;
  /** The acting actor (author, voter, moderator). */
  readonly actorId: Uuid;
  readonly subject: SubjectOf<A>;
  readonly authority: Authority;

  private constructor(action: A, principal: ActingPrincipal, subject: SubjectOf<A>, authority: Authority) {
    this.action = action;
    this.principal = principal;
    this.actorId = principal.actorId;
    this.subject = subject;
    this.authority = authority;
    Object.freeze(this);
  }

  static {
    issue = (action, principal, subject, authority) => new Authorized(action, principal, subject, authority);
  }

  /** Runtime half of the guard: true only for grants authorize() issued for `action`. */
  static verify(grant: unknown, action: ActionName): boolean {
    return typeof grant === 'object' && grant !== null && #genuine in grant && grant.#genuine && grant.action === action;
  }
}

export function issueGrant<A extends ActionName>(
  action: A,
  principal: ActingPrincipal,
  subject: SubjectOf<A>,
  authority: Authority,
): Authorized<A> {
  return issue(action, principal, subject, authority);
}
