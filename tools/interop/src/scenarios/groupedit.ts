// S3: Update(Group). A peblish edit of !lab shows on each peer, a peer's edit of its own community
// applies in peblish, and an Update for a community that is not the sender's own is refused.
import type { Group } from '../context.ts';
import { type KnownDefect, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';
import { prepare } from './support.ts';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

export const groupEdit: Group = {
  ids: ['S3'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);

      // S3/out: peblish edits !lab, and the peer shows the new description. Lemmy 0.19.21 parses the
      // embedded Group of an Update sent by the community itself as a Person and answers 400; Mbin
      // answers 200 and keeps the old description.
      const outKnown: KnownDefect | undefined =
        peer.name === 'lemmy'
          ? {
              explanation: 'Lemmy refuses an Update(Group) sent by the community itself (400: unknown variant `Group`, expected Person)',
              signature: 'got [failed status=400',
            }
          : peer.name === 'mbin'
            ? {
                explanation: 'Mbin answers 200 to an Update(Group) from the community itself and keeps the old description',
                signature: 'timed out waiting for mbin to show the new description',
              }
            : undefined;
      await rec.scenario(
        'S3/out',
        peer.name,
        async () => {
          const mine = `Edited by peblish ${ctx.run} for ${peer.name}`;
          const started = new Date();
          await peblish.updateCommunity('labadmin', community.id, { description: mine });
          await expectDelivery(
            ctx.sql,
            { since: started, type: 'Update', host: new URL(peer.origin).host },
            { state: 'delivered' },
            { timeoutMs: 45_000 },
          );
          await waitFor(
            `${peer.name} to show the new description`,
            async () => ((await peer.communityDescription(side.token, side.labOnPeer)) ?? '').includes(mine),
            { timeoutMs: 30_000 },
          );
          return 'the description edited in peblish shows on the peer';
        },
        outKnown,
      );

      // S3/in: the peer's moderator edits its own community; peblish applies the Update(Group) it announces.
      await rec.scenario('S3/in', peer.name, async () => {
        const theirs = `Edited on ${peer.name} ${ctx.run}`;
        const started = new Date();
        await peer.editCommunity(side.adminToken, side.peerCommunityId, `${peer.name} lab`, theirs);
        await expectInbound(
          ctx.sql,
          { since: started, type: 'Announce', actor: side.remote.apId, contains: theirs },
          { state: 'applied' },
          { timeoutMs: 40_000 },
        );
        await waitFor("peblish to hold the peer's description", async () => {
          const [row] = await ctx.sql<
            { summary_md: string | null; summary_html: string | null }[]
          >`select summary_md, summary_html from actors where ap_id = ${side.remote.apId}`;
          return (row?.summary_md ?? row?.summary_html ?? '').includes(theirs);
        });
        return "the peer's edit applied in peblish";
      });

      // A non-owner's Update(Group) is refused (sent from the rogue, which is nobody's community).
      await rec.scenario('S3/unauthorized', peer.name, async () => {
        const started = new Date();
        const id = `${rogue.origin}/activities/update/${ctx.run}${peer.name}`;
        const update = {
          id,
          type: 'Update',
          actor: rogue.actor('mallory'),
          to: [PUBLIC],
          cc: [side.remote.apId],
          object: {
            id: side.remote.apId,
            type: 'Group',
            preferredUsername: 'hijacked',
            name: 'hijacked',
            inbox: `${side.remote.apId}/inbox`,
          },
        };
        const sent = await rogue.send(rogue.actor('mallory'), update);
        if (sent.status !== 202) throw new Error(`peblish answered ${sent.status}: ${sent.body}`);
        await expectInbound(
          ctx.sql,
          { since: started, type: 'Update', contains: id },
          { state: 'skipped', reason: 'actor.update_unauthorized', detail: side.remote.apId },
        );
        return 'an Update(Group) from a stranger is actor.update_unauthorized';
      });
    }
  },
};
