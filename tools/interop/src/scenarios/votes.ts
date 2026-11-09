// V1: votes both ways. A peer's Like, Dislike and Undo reach peblish; peblish's users' votes reach
// the peer as announced Likes. Mbin's boost is an Announce of a bare IRI by a person, which
// peblish records and ignores.
import type { Group } from '../context.ts';
import { waitFor } from '../lab.ts';
import { expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';
import { postOnPeer, prepare, storedPost, tag } from './support.ts';

export const votes: Group = {
  ids: ['V1'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);

      await rec.scenario('V1', peer.name, async () => {
        const title = tag(ctx, 'V1', peer);
        const created = await peblish.createPost('alice', community.id, { title, bodyMd: 'Vote on this.' });
        ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: created.apId });
        const onPeer = await postOnPeer(side, side.labOnPeer, created.apId);
        const stored = await storedPost(ctx, created.apId);
        const voter = peer.actorUri(peer.user);

        const peerVote = (): Promise<number | undefined> =>
          ctx.sql<{ value: number }[]>`
            select v.value from votes v join actors a on a.id = v.voter_id
            where v.post_id = ${stored.id} and a.ap_id = ${voter}`.then((rows) => rows[0]?.value);
        const heldVote = async (expected: number | undefined) =>
          waitFor(`peblish to hold ${peer.name}'s vote ${expected}`, async () => (await peerVote()) === expected, { timeoutMs: 30_000 });

        // Into peblish: Like, Dislike, then Undo.
        let started = new Date();
        await peer.votePost(side.token, onPeer.id, 1);
        ctx.ledger.add({ kind: 'vote', side: peer.name, user: peer.user, target: created.apId, targetType: 'post', peerId: onPeer.id });
        await expectInbound(ctx.sql, { since: started, actor: voter, type: 'Like', contains: created.apId }, { state: 'applied' });
        await heldVote(1);

        // Mbin's API users are bots, and Mbin refuses a bot's up or down vote; only its favourite (a Like) works.
        if (peer.name !== 'mbin') {
          started = new Date();
          await peer.votePost(side.token, onPeer.id, -1);
          await expectInbound(ctx.sql, { since: started, actor: voter, type: 'Dislike', contains: created.apId }, { state: 'applied' });
          await heldVote(-1);
        }
        started = new Date();
        await peer.votePost(side.token, onPeer.id, 0);
        await expectInbound(ctx.sql, { since: started, actor: voter, type: 'Undo', contains: created.apId }, { state: 'applied' });
        await heldVote(undefined);

        // Mbin's own boost needs a person: its API users are bots and cannot vote. The same wire shape
        // (a Person's Announce of a bare IRI, as the spike saw from kbin.earth) comes from the rogue.
        if (peer.name === 'mbin') {
          started = new Date();
          const boost = {
            id: `${rogue.origin}/activities/announce/${ctx.run}`,
            type: 'Announce',
            actor: rogue.actor('mallory'),
            to: ['https://www.w3.org/ns/activitystreams#Public'],
            cc: [community.apId],
            object: created.apId,
          };
          const sent = await rogue.send(rogue.actor('mallory'), boost);
          if (sent.status !== 202) throw new Error(`peblish answered the boost ${sent.status}: ${sent.body}`);
          await expectInbound(
            ctx.sql,
            { since: started, actor: rogue.actor('mallory'), type: 'Announce', contains: created.apId },
            { state: 'skipped', reason: 'announce.bare_iri', detail: created.apId },
          );
        }

        // Out of peblish: bob's vote on alice's post shows as the peer's score.
        const base = (await peer.getPost(side.token, onPeer.id)).score;
        await peblish.vote('bob', { kind: 'post', id: stored.id }, 1);
        ctx.ledger.add({ kind: 'vote', side: 'peblish', user: 'bob', target: created.apId, targetType: 'post' });
        await waitFor(`${peer.name} to show bob's upvote`, async () => (await peer.getPost(side.token, onPeer.id)).score === base + 1);
        if (peer.name !== 'mbin') {
          await peblish.vote('bob', { kind: 'post', id: stored.id }, -1);
          await waitFor(`${peer.name} to show bob's downvote`, async () => (await peer.getPost(side.token, onPeer.id)).score === base - 1);
        }
        await peblish.vote('bob', { kind: 'post', id: stored.id }, 0);
        await waitFor(`${peer.name} to show bob's vote taken back`, async () => (await peer.getPost(side.token, onPeer.id)).score === base);
        return peer.name === 'mbin'
          ? "Like and Undo into peblish and bob's Like out; Dislike is n/a (Mbin bots cannot vote)"
          : 'Like, Dislike and Undo both ways';
      });
    }
  },
};
