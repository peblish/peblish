// R1: reports both ways.
//   R1/in   a peer's user reports alice's post in !lab: the Flag arrives and opens a report here.
//   R1/out  alice reports a post in the peer's community and asks for it to be sent on: the Flag,
//           signed as alice, reaches the peer, and Lemmy lists the report to its admin.
import type { Uuid } from '@peblish/schema/ids';
import type { Group } from '../context.ts';
import { waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { peerOwnPostInPeblish, postOnPeer, prepare, storedPost, tag } from './support.ts';

export const reports: Group = {
  ids: ['R1'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);

      await rec.scenario('R1/in', peer.name, async () => {
        const title = tag(ctx, 'R1 in', peer);
        const created = await peblish.createPost('alice', community.id, { title, bodyMd: 'A post to report.' });
        ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: created.apId });
        const onPeer = await postOnPeer(side, side.labOnPeer, created.apId);
        const stored = await storedPost(ctx, created.apId);
        const started = new Date();
        await peer.mod.reportPost(side.token, onPeer.id, `R1 ${ctx.run}`);
        await expectInbound(
          ctx.sql,
          { since: started, actor: peer.actorUri(peer.user), type: 'Flag', contains: created.apId },
          { state: 'applied' },
        );
        const report = await waitFor('peblish to open the report', async () => {
          const rows = await ctx.sql<{ number: number; local: boolean; status: string }[]>`
            select number, local, status from reports where target_post_id = ${stored.id as Uuid} order by created_at desc limit 1`;
          return rows[0];
        });
        if (report.local) throw new Error('the report from the peer is stored as local');
        return `the Flag opened report ${report.number} (${report.status})`;
      });

      await rec.scenario('R1/out', peer.name, async () => {
        const { post, stored } = await peerOwnPostInPeblish(ctx, side, tag(ctx, 'R1 out', peer));
        const started = new Date();
        await peblish.reportPost('alice', stored.id, 'spam', `R1 ${ctx.run}`, true);
        await expectDelivery(
          ctx.sql,
          { since: started, type: 'Flag', host: new URL(peer.origin).host, contains: post.apId },
          { state: 'delivered' },
        );
        const listed = await peer.mod.reported(side.adminToken, post.id);
        if (listed === null) return 'the Flag was delivered; the peer’s API lists no reports to check';
        await waitFor(`${peer.name} to list the report`, async () => (await peer.mod.reported(side.adminToken, post.id)) === true);
        return `the Flag was delivered and ${peer.name} lists the report`;
      });
    }
  },
};
