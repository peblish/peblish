import type { Principal } from '@peblish/schema/authz';
import type { RefusalReason } from '@peblish/schema/refusal';
import { db } from '../db/read.ts';
import type { Queryable } from '../db/read.ts';
import { policies } from '../registry/policies.gen.ts';
import { issueGrant, type Authorized } from './brand.ts';
import { frozenCopy } from './frozen.ts';
import { currentPrincipal } from './principal.ts';
import type { ActionName, Policy, SubjectOf } from './policy.ts';

// Owned by lane AZ after G0 (the brand in brand.ts stays G0's).

export type Decision<A extends ActionName> = { ok: true; grant: Authorized<A> } | { ok: false; reason: RefusalReason };

const table: { [K in ActionName]: Policy<SubjectOf<K>> } = policies;

/**
 * Decides `action` on `subject` for `principal`: Allow carries the grant every write
 * service requires, Deny carries exactly one closed RefusalReason. Pass `db` to read
 * inside an open transaction (the inbound pipeline), so the decision and the write agree.
 * The principal and subject are copied and deep-frozen before anything is awaited, so a
 * caller changing its objects afterwards changes neither the decision nor the grant. They
 * must be JSON-like plain data: anything else throws SnapshotError (frozen.ts).
 *
 * With `lock` (a mutation's recheck, inside its transaction) the principal is then
 * re-read from the database and the policy takes its row locks (see PolicyRequest.lock).
 */
export async function authorize<A extends ActionName>(
  action: A,
  principal: Principal,
  subject: SubjectOf<A>,
  options: { db?: Queryable; lock?: boolean } = {},
): Promise<Decision<A>> {
  if (principal.kind === 'anonymous') return { ok: false, reason: 'auth.required' };
  // Snapshot first: nothing the caller does once this function yields can reach the decision.
  const requested = frozenCopy(principal, 'principal');
  const frozenSubject = frozenCopy(subject, 'subject');
  const q = options.db ?? db();
  const lock = options.lock ?? false;
  let acting = requested;
  if (lock) {
    const current = await currentPrincipal(q, requested);
    if (!current.ok) return current;
    acting = frozenCopy(current.principal, 'principal');
  }
  const policy: Policy<SubjectOf<A>> = table[action];
  const result = await policy({ principal: acting, subject: frozenSubject, db: q, lock });
  if (!result.ok) return result;
  return { ok: true, grant: issueGrant(action, acting, frozenSubject, frozenCopy(result.authority, 'authority')) };
}
