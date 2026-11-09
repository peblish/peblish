import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane COMM. The NSFW gate's 16+ declaration (a signed-in person who has none yet
// declares one on the gate page). Nothing consumes it: the age_declarations row is the fact.
export const events = {
  /** A local person declared they are 16 or older; emitted only when the declaration row was new. */
  'age.declared': type({ type: "'age.declared'", v: '1', actorId: Uuid }),
};
