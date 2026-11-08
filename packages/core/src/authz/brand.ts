import type { ActingPrincipal, Authority } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { Frozen } from './frozen.ts';
import type { ActionName, SubjectOf } from './policy.ts';

/** Required by the constructor; it never leaves this module, so nothing else can construct. */
const issuance = Symbol('peblish.grant-issuance');
/** Every grant issueGrant created. verify() accepts nothing else: no copy, clone or look-alike. */
const issued = new WeakSet<object>();

let issue: <A extends ActionName>(
  action: A,
  principal: Frozen<ActingPrincipal>,
  subject: SubjectOf<A>,
  authority: Frozen<Authority>,
) => Authorized<A>;

/**
 * Proof that authorize() allowed `action` on `subject` for `principal`. Every core write
 * service takes one, so an unauthorized write does not compile (the private field makes the
 * class nominal). At runtime the constructor demands a module-private token, so neither
 * Reflect.construct on a grant's constructor nor a subclass can mint one, and verify()
 * accepts only instances issueGrant recorded. Only authorize.ts issues grants (lint rule
 * authz-brand); mutations verify them.
 */
export class Authorized<A extends ActionName> {
  readonly #genuine = true;
  readonly action: A;
  readonly principal: Frozen<ActingPrincipal>;
  /** The acting actor (author, voter, moderator, or the instance actor for system work). */
  readonly actorId: Uuid;
  readonly subject: SubjectOf<A>;
  readonly authority: Frozen<Authority>;

  private constructor(token: symbol, action: A, principal: Frozen<ActingPrincipal>, subject: SubjectOf<A>, authority: Frozen<Authority>) {
    if (token !== issuance) throw new TypeError('grants are issued by authorize() only');
    this.action = action;
    this.principal = principal;
    this.actorId = principal.actorId;
    this.subject = subject;
    this.authority = authority;
    Object.freeze(this);
  }

  static {
    issue = (action, principal, subject, authority) => {
      const grant = new Authorized(issuance, action, principal, subject, authority);
      issued.add(grant);
      return grant;
    };
  }

  /** Runtime half of the guard: true only for a grant issueGrant created for `action`. */
  static verify(grant: unknown, action: ActionName): boolean {
    return (
      typeof grant === 'object' && grant !== null && issued.has(grant) && #genuine in grant && grant.#genuine && grant.action === action
    );
  }
}

/** Issues a grant over frozen snapshots (authorize() takes them before the policy runs). */
export function issueGrant<A extends ActionName>(
  action: A,
  principal: Frozen<ActingPrincipal>,
  subject: SubjectOf<A>,
  authority: Frozen<Authority>,
): Authorized<A> {
  return issue(action, principal, subject, authority);
}
