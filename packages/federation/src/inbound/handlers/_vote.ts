import { db } from '@peblish/core/db/read';
import { castVote } from '@peblish/core/votes/cast';
import { checkAuthorIsPerson, checkCommunity, communityById, grantFor, requireContent } from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';

// Like, Dislike and the Undo of either. A vote is the voter's own (the policy allows the
// remote voter as itself), found by voter and target, never by the Like's id: Lemmy's
// Undo(Like) embeds a freshly minted Like, and a change of direction replaces the vote under
// the peer's new id.

export type Cast = { value: 1 | -1; apId: string; raw: unknown } | { value: 0 };

export async function prepareVote(ctx: InboundContext, targetApId: string, cast: Cast): Promise<Prepared> {
  checkAuthorIsPerson(ctx);
  const target = await requireContent(db(), targetApId);
  const community = await communityById(db(), target.communityId);
  checkCommunity(ctx, community, ctx.activity.communityApId);
  return prepared(ctx, async (t) => {
    const grant = await grantFor(ctx, t, 'vote.cast', { target: { kind: target.kind, id: target.id } });
    // The vote already held, or none to take back, changes nothing.
    if (!(await castVote.within(t, grant, cast)).changed) throw skip('vote.unchanged', target.apId);
    return { communityId: community.id, objectApId: target.apId, relay: true };
  });
}
