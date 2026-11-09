import { banFromCommunity, unbanFromCommunity } from '@peblish/core/moderation/ban';
import { checkCommunity, claimFor, claimedCommunity, grantFor } from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';
import { prepareSiteBan } from './_site-ban.ts';

// Block and Undo(Block) of a person in a community. The target is the community; a Block whose
// target is a whole instance (a path of "/") is a site ban (_site-ban.ts).
// Lemmy's `expires` and PieFed's `endTime` both reach the mapping as `expires`, and a ban that
// ended before it arrived is skipped (the mutation refuses a ban in the past).

export type BlockFields = {
  objectApId: string;
  targetApId: string;
  reason: string | null;
  removeData: boolean | null;
  expires: Date | null;
};

export async function prepareBan(ctx: InboundContext, block: BlockFields, banning: boolean): Promise<Prepared> {
  if (new URL(block.targetApId).pathname === '/') return prepareSiteBan(ctx, block, banning);
  if (banning && block.expires && block.expires.getTime() <= Date.now()) throw skip('block.expired', block.targetApId);
  const community = await claimedCommunity(ctx, block.targetApId);
  if (community.kind !== 'Group') throw skip('community.mismatch', block.targetApId);
  checkCommunity(ctx, community, claimFor(ctx, community));
  const banned = await ctx.actor(block.objectApId);
  const reason = block.reason?.trim() ? block.reason.slice(0, 10_000) : null;
  return prepared(ctx, async (t) => {
    const subject = { communityId: community.id, targetActorId: banned.id };
    const activityApId = ctx.activity.id;
    if (banning) {
      const grant = await grantFor(ctx, t, 'mod.ban', subject);
      await banFromCommunity.within(t, grant, {
        reason,
        activityApId,
        expiresAt: block.expires?.toISOString() ?? null,
        removeContent: block.removeData === true,
      });
    } else {
      await unbanFromCommunity.within(t, await grantFor(ctx, t, 'mod.unban', subject), { reason, activityApId });
    }
    return { communityId: community.id, objectApId: banned.apId, relay: true };
  });
}
