// B1: a Dislike for a post peblish has not stored is skipped as target.missing; the missing-object
// job fetches the post, and the vote then applies once. A new community on the peer and a Dislike
// sent as soon as peblish's follow is accepted put the vote ahead of the 30 second backfill job.
import type { Context, Group } from '../context.ts';
import { NotApplicable, waitFor } from '../lab.ts';
import { expectInbound, Mismatch } from '../match.ts';
import { followRow, peblish } from '../peblish.ts';
import type { Peer } from '../peers/types.ts';
import { prepare, tag } from './support.ts';

async function attempt(ctx: Context, peer: Peer, adminToken: string, userToken: string, n: number) {
  const name = `b1${ctx.run}${n}`.slice(0, 20);
  const communityId = await peer.createCommunity(adminToken, name, `B1 ${name}`);
  const post = await peer.createPost(userToken, communityId, tag(ctx, `B1 older ${n}`, peer), 'Posted before peblish follows.');
  ctx.ledger.add({ kind: 'object', side: peer.name, user: peer.user, type: 'post', apId: post.apId, peerId: post.id });
  const handle = `!${name}@${new URL(peer.origin).host}`;
  const followed = await peblish.followRemote('alice', handle);
  ctx.ledger.add({ kind: 'follow', side: 'peblish', user: 'alice', community: handle });
  await waitFor('the follow to be accepted', async () => (await followRow('alice', followed.communityId))?.state === 'accepted', {
    timeoutMs: 30_000,
  });
  const started = new Date();
  await peer.votePost(userToken, post.id, -1);
  return { post, started, voter: peer.actorUri(peer.user), communityApId: followed.apId };
}

export const missing: Group = {
  ids: ['B1'],
  async run(ctx) {
    for (const peer of ctx.peers) {
      await ctx.rec.scenario('B1', peer.name, async () => {
        if (peer.name === 'mbin')
          throw new NotApplicable(
            'Mbin never announces its own members’ activity to a remote follower (see P3), so there is no announced Dislike to hold',
          );
        const side = await prepare(ctx, peer);
        let last: unknown;
        for (let n = 1; n <= 3; n += 1) {
          const { post, started, voter } = await attempt(ctx, peer, side.adminToken, side.token, n);
          try {
            await expectInbound(
              ctx.sql,
              { since: started, type: 'Announce', contains: post.apId },
              { state: 'skipped', reason: 'target.missing', detail: post.apId },
            );
          } catch (error) {
            // The backfill won the race and stored the post first: the vote applied at once. Try a new community.
            if (error instanceof Mismatch && /got \[applied\]/.test(error.message)) {
              last = error;
              continue;
            }
            throw error;
          }
          await waitFor(
            'peblish to store the missing post',
            async () => (await ctx.sql`select 1 from posts where ap_id = ${post.apId}`).length > 0,
            { timeoutMs: 120_000 },
          );
          await expectInbound(
            ctx.sql,
            { since: started, type: 'Announce', contains: post.apId },
            { state: 'applied' },
            { timeoutMs: 120_000 },
          );
          const rows = await ctx.sql<{ value: number }[]>`
            select v.value from votes v join posts p on p.id = v.post_id join actors a on a.id = v.voter_id
            where p.ap_id = ${post.apId} and a.ap_id = ${voter}`;
          if (rows.length !== 1 || rows[0]?.value !== -1)
            throw new Error(`expected one Dislike by ${voter}, found ${JSON.stringify(rows)}`);
          return `Dislike held as target.missing, the post fetched, the vote applied once (attempt ${n})`;
        }
        throw new Error(`the backfill stored the post before the Dislike three times: ${String(last)}`);
      });
    }
  },
};
