import type { Principal } from '@peblish/schema/authz';
import { ageOn, dateOfBirth } from '@peblish/schema/identity';
import { authorize } from '../authz/authorize.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { defineMutation } from '../tx/mutation.ts';

/**
 * Records the grant holder's 16+ declaration. Declaring twice changes nothing and emits
 * nothing, so a repeated POST (a second tab, a retry) is harmless.
 */
export const declareAge = defineMutation({
  action: 'age.declare',
  emits: ['age.declared'],
  async run(t, grant) {
    const inserted = await t.db
      .insert(ageDeclarations)
      .values({ actorId: grant.actorId })
      .onConflictDoNothing()
      .returning({ actorId: ageDeclarations.actorId });
    if (inserted.length > 0) await t.emit({ type: 'age.declared', v: 1, actorId: grant.actorId });
    return { created: inserted.length > 0 };
  },
});

/**
 * age.declare for web: the date of birth is turned into an age here and dropped; only the
 * declaration is stored. A date that is not real (or is in the future) is `age.declaration_required`.
 */
export async function declareAgeAs(
  principal: Principal,
  form: { day: string; month: string; year: string },
  now = new Date(),
): Promise<Result<{ created: boolean }>> {
  const dob = dateOfBirth(form.day, form.month, form.year, now);
  const decision = await authorize('age.declare', principal, { age: dob ? ageOn(dob, now) : null });
  if (!decision.ok) return decision;
  return refusedAsResult(() => declareAge(decision.grant, undefined));
}
