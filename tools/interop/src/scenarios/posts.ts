// P1, P2, N1: posts in both directions.
import { HttpError, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish, postByApId } from '../peblish.ts';
import type { Group } from '../context.ts';
import type { Side } from './support.ts';
import { mbinUnannounced, peerOwnPostInPeblish, postOnPeer, prepare, storedPost, tag } from './support.ts';

/** True once the peer no longer shows the post: deleted or removed, or not found. */
async function vanished(side: Side, peerPostId: number): Promise<boolean> {
  try {
    const post = await side.peer.getPost(side.token, peerPostId);
    return post.deleted || post.removed;
  } catch (error) {
    if (error instanceof HttpError && [400, 404, 410].includes(error.status)) return true;
    throw error;
  }
}

export const posts: Group = {
  ids: ['P1', 'P2', 'P3', 'N1'],
  async run(ctx) {
    const { rec, community } = ctx;
    const sides: Side[] = [];
    for (const peer of ctx.peers) sides.push(await prepare(ctx, peer));

    for (const side of sides) {
      const { peer } = side;

      // P1: a peblish user posts text and a link into !lab; each shows on the peer, then changes, then goes.
      await rec.scenario('P1', peer.name, async () => {
        const text = tag(ctx, 'P1 text', peer);
        const started = new Date();
        const created = await peblish.createPost('alice', community.id, { title: text, bodyMd: 'Hello from **peblish**.' });
        ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: created.apId });
        await expectDelivery(
          ctx.sql,
          { since: started, type: 'Announce', inner: 'Create', host: new URL(peer.origin).host, contains: text },
          { state: 'delivered' },
        );
        const shown = await postOnPeer(side, side.labOnPeer, created.apId);
        if (shown.title !== text) throw new Error(`title ${JSON.stringify(shown.title)}`);
        if (!shown.body?.includes('Hello from') || !shown.body.includes('peblish')) throw new Error(`body ${JSON.stringify(shown.body)}`);
        const author = `${ctx.community.apId.replace(/\/ap\/c\..*/, '')}`;
        if (!shown.creatorApId.startsWith(author)) throw new Error(`creator ${shown.creatorApId}`);

        const link = tag(ctx, 'P1 link', peer);
        const linked = await peblish.createPost('alice', community.id, { title: link, url: 'https://example.test/lab-article' });
        ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: linked.apId });
        const linkShown = await postOnPeer(side, side.labOnPeer, linked.apId);
        if (linkShown.url !== 'https://example.test/lab-article') throw new Error(`link url ${JSON.stringify(linkShown.url)}`);

        await peblish.editPost('alice', created.id, { title: `${text} (edited)`, bodyMd: 'Edited **body**.' });
        await waitFor(`${peer.name} to show the edit`, async () => {
          const now = await peer.getPost(side.token, shown.id);
          return now.title === `${text} (edited)` && now.body?.includes('Edited') && now;
        });

        await peblish.deletePost('alice', created.id);
        await waitFor(`${peer.name} to drop the post`, () => vanished(side, shown.id));
        return `text and link shown, edit applied, delete applied (peer posts ${shown.id} and ${linkShown.id})`;
      });

      // P2: the peer's user posts into !lab; peblish stores it once and relays it to the other peers.
      await rec.scenario('P2', peer.name, async () => {
        const title = tag(ctx, 'P2', peer);
        const started = new Date();
        const post = await peer.createPost(side.token, side.labOnPeer, title, `Posted from ${peer.name}.`);
        const apId = post.apId;
        const entry = ctx.ledger.add({ kind: 'object', side: peer.name, user: peer.user, type: 'post', apId, peerId: post.id });
        const actor = peer.actorUri(peer.user);
        await expectInbound(ctx.sql, { since: started, actor, type: 'Create', contains: title }, { state: 'applied' });
        const stored = await storedPost(ctx, apId);
        const [count] = await ctx.sql<{ n: number }[]>`select count(*)::int as n from posts where ap_id = ${apId}`;
        if (count?.n !== 1) throw new Error(`${count?.n} stored copies of ${apId}`);
        const others = sides.filter((s) => s.peer.name !== peer.name);
        for (const other of others) {
          await expectDelivery(
            ctx.sql,
            { since: started, type: 'Announce', host: new URL(other.peer.origin).host, contains: title },
            { state: 'delivered' },
          );
          await postOnPeer(other, other.labOnPeer, apId);
        }
        await peer.deletePost(side.token, post.id);
        ctx.ledger.done(entry, 'deleted by the scenario');
        await waitFor('peblish to mark the post deleted', async () => {
          const [row] = await ctx.sql<{ deleted_at: Date | null }[]>`select deleted_at from posts where ap_id = ${apId}`;
          return row?.deleted_at && row;
        });
        return `stored once (${stored.id}), relayed to ${others.map((o) => o.peer.name).join(', ') || 'no other peer selected'}, delete applied`;
      });

      // P3: a post by the peer's own user in the peer's own community reaches peblish, announced by the community.
      await rec.scenario(
        'P3',
        peer.name,
        async () => {
          const { stored } = await peerOwnPostInPeblish(ctx, side, tag(ctx, 'P3', peer));
          return `stored ${stored.id}, relayed by the peer's community`;
        },
        peer.name === 'mbin' ? mbinUnannounced(side.remote.apId) : undefined,
      );

      // N1: remote NSFW is refused by default (the setting that accepts it is ADM's).
      await rec.scenario('N1', peer.name, async () => {
        const title = tag(ctx, 'N1 nsfw', peer);
        const started = new Date();
        const post = await peer.createPost(side.token, side.labOnPeer, title, 'Marked sensitive.', { nsfw: true });
        const actor = peer.actorUri(peer.user);
        await expectInbound(
          ctx.sql,
          { since: started, actor, type: 'Create', contains: title },
          { state: 'skipped', reason: 'content.nsfw_rejected', detail: post.apId },
        );
        if (await postByApId(post.apId)) throw new Error('the sensitive post was stored');
        return `Create skipped as content.nsfw_rejected; nothing stored`;
      });
    }
  },
};
