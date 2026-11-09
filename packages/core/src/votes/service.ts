import type { Principal } from '@peblish/schema/authz';
import type { ContentRef } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { castVote } from './cast.ts';

export type Tally = { upvotes: number; downvotes: number };

/** The target's tally as the database counts it now; null when it does not exist. */
export async function readTally(target: ContentRef): Promise<Tally | null> {
  const table = target.kind === 'post' ? posts : comments;
  const [row] = await db().select({ upvotes: table.upvotes, downvotes: table.downvotes }).from(table).where(eq(table.id, target.id));
  return row ?? null;
}

/**
 * A signed-in person's vote for web: authorize, cast, and answer with the vote now held and
 * the tally, so a page can settle on the server's numbers. A refusal, from the precheck or
 * the recheck inside the transaction, comes back as a result (the page shows or ignores it).
 */
export async function voteAs(
  principal: Principal,
  target: ContentRef,
  value: -1 | 0 | 1,
): Promise<Result<{ value: -1 | 0 | 1; tally: Tally }>> {
  const decision = await authorize('vote.cast', principal, { target });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    const result = await castVote(decision.grant, { value });
    return { value: result.value, tally: (await readTally(target)) ?? { upvotes: 0, downvotes: 0 } };
  });
}
