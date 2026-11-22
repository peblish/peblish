import type { Principal } from '@peblish/schema/authz';
import type { ContentRef } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { castVote, type Tally } from './cast.ts';

/**
 * A signed-in person's vote for web: authorize, cast, and answer with the vote now held and
 * the tally, so a page can settle on the server's numbers. A refusal, from the precheck or
 * the recheck inside the transaction, comes back as a result (the page shows or ignores it).
 * Value 0 asks as a withdrawal from the start (vote.cast's `withdraw`): on content the age gate
 * withholds it passes only for a voter who holds a vote there, and only takes that vote back. The
 * tally is decided inside the vote's transaction (castVote): null when the gate withholds the
 * target from the voter, who then learns nothing of it.
 */
export async function voteAs(
  principal: Principal,
  target: ContentRef,
  value: -1 | 0 | 1,
): Promise<Result<{ value: -1 | 0 | 1; tally: Tally | null }>> {
  const decision = await authorize('vote.cast', principal, value === 0 ? { target, withdraw: true } : { target });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    const result = await castVote(decision.grant, { value });
    return { value: result.value, tally: result.tally ?? null };
  });
}
