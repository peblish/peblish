// F1, F2: following in both directions. The Accept is the first signed round trip, so every
// later scenario depends on these.
import type { Group } from '../context.ts';
import { sleep, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound, type Sql } from '../match.ts';
import { followRow, peblish } from '../peblish.ts';
import type { Peer } from '../peers/types.ts';

/** Leaves the peblish community if `user` still follows it from an earlier run, and waits for peblish to hear. */
async function unfollowIfFollowing(sql: Sql, peer: Peer, user: string, token: string, communityId: string, handle: string) {
  const resolved = await peer.resolveCommunity(token, handle);
  if (resolved.subscribed === 'NotSubscribed') return;
  await peer.unfollow(token, resolved.id);
  await waitFor(
    `${peer.name} follower row to leave peblish`,
    async () =>
      (
        await sql`select 1 from follows f join actors a on a.id = f.follower_id where f.followee_id = ${communityId} and a.ap_id = ${peer.actorUri(user)}`
      ).length === 0,
  );
}

export const follows: Group = {
  ids: ['F1', 'F2'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      // F1: a peer's user follows !lab@peblish.lab.test and the Accept arrives.
      await rec.scenario('F1', peer.name, async () => {
        // Mbin sends no Follow when a user subscribes again after unsubscribing, so it gets a new account.
        const user = peer.freshUser ? await peer.freshUser(ctx.run) : peer.user;
        const token = await peer.login(user);
        if (!peer.freshUser) await unfollowIfFollowing(ctx.sql, peer, user, token, community.id, community.handle);
        const started = new Date();
        const resolved = await peer.resolveCommunity(token, community.handle);
        const initial = await peer.follow(token, resolved.id);
        ctx.ledger.add({ kind: 'follow', side: peer.name, user, community: community.handle });
        const actor = peer.actorUri(user);
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
          const unfollowed = new Date();
          await peblish.unfollow('alice', resolved.id as never);
          await expectDelivery(ctx.sql, { since: unfollowed, type: 'Undo', host: new URL(peer.origin).host }, { state: 'delivered' });
          // PieFed handles inbox posts in a queue and drops a Follow that overtakes the Undo before it.
          await sleep(8_000);
        }
        const started = new Date();
        const followed = await peblish.followRemote('alice', handle);
        ctx.ledger.add({ kind: 'follow', side: 'peblish', user: 'alice', community: handle });
        if (followed.state !== 'pending') throw new Error(`expected a pending follow, got ${followed.state}`);
        await expectDelivery(ctx.sql, { since: started, type: 'Follow' }, { state: 'delivered' });
        await expectInbound(ctx.sql, { since: started, type: 'Accept' }, { state: 'applied' });
        await waitFor('the follow to read accepted', async () => (await followRow('alice', followed.communityId))?.state === 'accepted');
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
