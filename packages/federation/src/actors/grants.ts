import { authorize } from '@peblish/core/authz/authorize';
import type { Authorized } from '@peblish/core/authz/brand';
import type { ActionName, SubjectOf } from '@peblish/core/authz/policy';
import { systemPrincipal } from '@peblish/core/authz/system';
import { db } from '@peblish/core/db/read';

/**
 * A grant for something the instance does as itself while importing what a peer sent
 * (systemPrincipal 'import'). A refusal here is a bug in the caller's checks, so it throws.
 */
export async function importGrant<A extends ActionName>(action: A, subject: SubjectOf<A>): Promise<Authorized<A>> {
  const decision = await authorize(action, await systemPrincipal(db(), 'import'), subject);
  if (!decision.ok) throw new Error(`${action} refused: ${decision.reason}`);
  return decision.grant;
}
