import type { ActingPrincipal, Authority } from '@peblish/schema/authz';
import type { RefusalReason } from '@peblish/schema/refusal';
import type { AssertNever, Overlap } from '@peblish/schema/registry';
import type { Queryable } from '../db/read.ts';
import type { policies, policyAreas } from '../registry/policies.gen.ts';

// Owned by lane AZ after G0. A policy decides one action. Policies are registered by glob
// from authz/actions/<area>.ts (each exports `policies`, owned by the area's lane); the
// action catalogue is the union of their keys.

export type PolicyResult = { ok: true; authority: Authority } | { ok: false; reason: RefusalReason };

export type PolicyRequest<S> = {
  principal: ActingPrincipal;
  /** What the action applies to; the grant carries it so a service cannot swap targets. */
  subject: S;
  /** Read inside the caller's transaction when one is open, else the read pool. */
  db: Queryable;
};

export type Policy<S> = (request: PolicyRequest<S>) => Promise<PolicyResult>;

type Policies = typeof policies;
export type ActionName = keyof Policies;
export type SubjectOf<A extends ActionName> = Parameters<Policies[A]>[0]['subject'];

export type DuplicateActions = AssertNever<Overlap<typeof policyAreas>>;

export const allow = (authority: Authority): PolicyResult => ({ ok: true, authority });
export const deny = (reason: RefusalReason): PolicyResult => ({ ok: false, reason });
