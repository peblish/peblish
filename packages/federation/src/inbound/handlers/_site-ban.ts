import { banFromSite, unbanFromSite } from '@peblish/core/bans/site';
import { grantFor } from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';
import type { BlockFields } from './_ban.ts';

// Block and Undo(Block) of a person aimed at a whole instance (a target with the path "/"):
// a site ban, as Lemmy and PieFed send it to every instance they know when one of their
// admins bans a user of theirs. Lemmy's receivers refuse an object on their own domain, require
// the actor and the object on the target's domain, ban the person and never ask whether the
// actor is an admin, and so do we: the origin rule is all there is. A peer can only ever ban
// its own people, and the ban is recorded as the peer's (source 'remote', owner authority).
//
// It names no community, so the mapped community is ignored and the Announce of a community
// is not accepted for it (the policy refuses an announced principal). A ban that arrives while
// one is held changes nothing, ours included. An Undo lifts only a ban a peer set.

/** PieFed writes a permanent ban as an end in the year 2100. */
const permanentFrom = Date.UTC(2100, 0, 1);

export async function prepareSiteBan(ctx: InboundContext, block: BlockFields, banning: boolean): Promise<Prepared> {
  const { origin } = new URL(ctx.activity.actorApId);
  for (const iri of [block.targetApId, block.objectApId]) {
    if (new URL(iri).origin !== origin) throw skip('ban.origin_mismatch', iri);
  }
  if (banning && block.expires && block.expires.getTime() <= Date.now()) throw skip('block.expired', block.targetApId);
  const person = await ctx.actor(block.objectApId);
  const reason = block.reason?.trim() ? block.reason.slice(0, 10_000) : null;
  const expires = block.expires && block.expires.getTime() < permanentFrom ? block.expires : null;
  return prepared(ctx, async (t) => {
    const subject = { targetActorId: person.id };
    const activityApId = ctx.activity.id;
    if (banning) {
      const grant = await grantFor(ctx, t, 'mod.site_ban', subject);
      await banFromSite.within(t, grant, {
        reason,
        activityApId,
        expiresAt: expires?.toISOString() ?? null,
        removeContent: block.removeData === true,
      });
    } else {
      await unbanFromSite.within(t, await grantFor(ctx, t, 'mod.site_unban', subject), { reason, activityApId });
    }
    return { objectApId: person.apId };
  });
}
