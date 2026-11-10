import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { pinPost, unpinPost } from '@peblish/core/moderation/pin';
import { mirrorModerators } from '@peblish/core/remote/moderators';
import { eq, or } from 'drizzle-orm';
import { importGrant } from '../../actors/grants.ts';
import type { ResolvedActor } from '../../actors/resolve.ts';
import { checkCommunity, claimFor, claimedCommunity, communityById, grantFor, storedContent } from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { fetchModerators } from '../moderators/refresh.ts';
import { skip } from '../reasons.ts';

// Add and Remove on a community's collections. Two are read:
// - featured (pin and unpin): the object is a post, the target the featured collection of the
//   post's community. A moderator's, or the community's, action; core decides which.
// - moderators: a change to who moderates a remote community. The activity only says that the
//   list changed: the collection is read again from the community's origin and mirrored, so
//   the mirror is what the community publishes, not what an activity claims. A local
//   community's moderators change here, never by a peer's activity.

type Urls = { featured: string; moderators: string };

async function collectionUrls(communityId: string): Promise<Urls & { apId: string }> {
  const [row] = await db()
    .select({ apId: actors.apId, featuredUrl: actors.featuredUrl, moderatorsUrl: actors.moderatorsUrl })
    .from(actors)
    .where(eq(actors.id, communityId));
  if (!row) throw skip('target.missing', communityId);
  return { apId: row.apId, featured: row.featuredUrl ?? `${row.apId}/featured`, moderators: row.moderatorsUrl ?? `${row.apId}/moderators` };
}

async function prepareFeatured(
  ctx: InboundContext,
  postId: string,
  communityId: string,
  targetApId: string,
  pinning: boolean,
): Promise<Prepared> {
  const community = await communityById(db(), communityId);
  checkCommunity(ctx, community, claimFor(ctx, community));
  if (targetApId !== (await collectionUrls(communityId)).featured) throw skip('collection.mismatch', targetApId);
  return prepared(ctx, async (t) => {
    const input = { activityApId: ctx.activity.id };
    if (pinning) await pinPost.within(t, await grantFor(ctx, t, 'mod.pin', { postId }), input);
    else await unpinPost.within(t, await grantFor(ctx, t, 'mod.unpin', { postId }), input);
    return { communityId, relay: true };
  });
}

/** The community whose moderators collection is `targetApId`: the one the activity names (checked against the Announce, never fetched), else a stored one. */
async function moderatorsOwner(ctx: InboundContext, claim: string | null, targetApId: string): Promise<ResolvedActor> {
  if (claim !== null) return claimedCommunity(ctx, claim);
  if (ctx.announce) return ctx.announce.community;
  const [row] = await db()
    .select({ id: actors.id })
    .from(actors)
    .where(or(eq(actors.moderatorsUrl, targetApId), eq(actors.apId, targetApId.replace(/\/moderators$/, ''))));
  if (!row) throw skip('collection.unknown', targetApId);
  return communityById(db(), row.id);
}

async function prepareModerators(ctx: InboundContext, objectApId: string, targetApId: string): Promise<Prepared> {
  const community = await moderatorsOwner(ctx, ctx.activity.communityApId, targetApId);
  if (community.kind !== 'Group' || targetApId !== (await collectionUrls(community.id)).moderators) {
    throw skip('collection.unknown', targetApId);
  }
  if (community.local) throw skip('moderators.local_collection', community.apId);
  checkCommunity(ctx, community, claimFor(ctx, community));
  const fetched = await fetchModerators(community.id, ctx.fetch);
  const grant = await importGrant('remote.moderators_mirror', { communityId: community.id });
  return prepared(ctx, async (t) => {
    await mirrorModerators.within(t, grant, fetched);
    return { objectApId };
  });
}

export async function prepareCollection(ctx: InboundContext, adding: boolean): Promise<Prepared> {
  const { activity } = ctx;
  if (activity.type !== 'Add' && activity.type !== 'Remove') throw new TypeError('prepareCollection needs an Add or a Remove');
  const content = await storedContent(db(), activity.objectApId);
  if (content?.kind === 'post') return prepareFeatured(ctx, content.id, content.communityId, activity.targetApId, adding);
  return prepareModerators(ctx, activity.objectApId, activity.targetApId);
}
