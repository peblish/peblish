// F1, F2: following in both directions. The Accept is the first signed round trip, so every
// later scenario depends on these.
import { followRow, peblish, sql as db } from '../peblish.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { sleep, waitFor } from '../lab.ts';
import type { Group } from '../context.ts';
import type { Peer } from '../peers/types.ts';

/** Leaves the peblish community if `peer.user` still follows it from an earlier run, and waits for peblish to hear. */
async function unfollowIfFollowing(peer: Peer, token: string, communityApId: string, communityId: string) {
  const resolved = await peer.resolveCommunity(token, `!lab@peblish.lab.test`);
  if (resolved.subscribed === 'NotSubscribed') return;
  await peer.unfollow(token, resolved.id);
  await waitFor(
    `${peer.name} follower row to leave peblish`,
    async () =>
      (
        await db()`select 1 from follows f join actors a on a.id = f.follower_id where f.followee_id = ${communityId} and a.ap_id = ${peer.actorUri(peer.user)}`
      ).length === 0,
  );
  void communityApId;
}

export const follows: Group = {
  ids: ['F1', 'F2'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const token = await peer.login(peer.user);

      // F1: a peer's user follows !lab@peblish.lab.test and the Accept arrives.
      await rec.scenario('F1', peer.name, async () => {
        await unfollowIfFollowing(peer, token, community.apId, community.id);
        const started = new Date();
        const resolved = await peer.resolveCommunity(token, community.handle);
        const initial = await peer.follow(token, resolved.id);
        const actor = peer.actorUri(peer.user);
        ctx.ledger.add({ kind: 'follow', side: peer.name, user: peer.user, community: community.handle });
        await expectInbound(ctx.sql, { since: started, actor, type: 'Follow', contains: community.apId }, { state: 'applied' });
        await waitFor(
          `${peer.name} to show Subscribed`,
          async () => (await peer.resolveCommunity(token, community.handle)).subscribed === 'Subscribed',
        );
        const accept = await expectDelivery(ctx.sql, { since: started, type: 'Accept' }, { state: 'delivered' });
        return `follow returned ${initial}, then Subscribed; Accept to ${accept.inbox} after ${accept.attempts} attempt(s)`;
      });

      // F2: a peblish user follows a community on the peer: pending, Accept, accepted, backfill, moderators.
      await rec.scenario('F2', peer.name, async () => {
        const handle = peer.communityHandle();
        const resolved = await peblish.resolve(handle);
        const existing = await followRow('alice', resolved.id as never);
        if (existing) {
          await peblish.unfollow('alice', resolved.id as never);
          await sleep(1_000);
        }
        const started = new Date();
        const followed = await peblish.followRemote('alice', handle);
        ctx.ledger.add({ kind: 'follow', side: 'peblish', user: 'alice', community: handle });
        if (followed.state !== 'pending') throw new Error(`expected a pending follow, got ${followed.state}`);
        await expectDelivery(ctx.sql, { since: started, type: 'Follow' }, { state: 'delivered' });
        await expectInbound(ctx.sql, { since: started, type: 'Accept' }, { state: 'applied' });
        const accepted = await waitFor(
          'the follow to read accepted',
          async () => (await followRow('alice', followed.communityId))?.state === 'accepted',
        );
        void accepted;
        const backfill = await waitFor(
          `the backfill of ${handle}`,
          async () => {
            const [row] = await ctx.sql<
              { state: string; posts: number }[]
            >`select state, posts from backfills where community_id = ${followed.communityId}`;
            return row && ['done', 'failed'].includes(row.state) ? row : null;
          },
          { timeoutMs: 90_000 },
        );
        if (backfill.state !== 'done') throw new Error(`backfill ended ${backfill.state}`);
        const mirrored = await peblish.mirrorModerators(followed.communityId);
        const [moderatorRow] = await ctx.sql<
          { moderators: number }[]
        >`select count(*)::int as moderators from community_moderators where community_id = ${followed.communityId}`;
        const moderators = moderatorRow?.moderators ?? 0;
        if (moderators < 1) throw new Error(`no moderators mirrored (mirror: ${JSON.stringify(mirrored)})`);
        return `accepted; backfill done with ${backfill.posts} post(s); ${moderators} moderator(s) mirrored`;
      });
    }
  },
};
