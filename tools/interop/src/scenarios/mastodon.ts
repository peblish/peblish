// V2: a follower that poses as Mastodon (the rogue's NodeInfo says so) gets the bare Announce of
// the Page, threadiverse peers get Announce(Create(Page)), and no inbox gets both.
import type { Group } from '../context.ts';
import { Pending, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { rogue, typesOf } from '../rogue-client.ts';
import { tag } from './support.ts';

export const mastodon: Group = {
  ids: ['V2'],
  async run(ctx) {
    const { rec, community } = ctx;
    const fan = rogue.actor('mastofan');
    /** The rogue takes its Follow back, so a run leaves !lab with the followers it had. */
    const unfollow = () =>
      rogue.send(fan, {
        id: `${rogue.origin}/activities/undo/${ctx.run}`,
        type: 'Undo',
        actor: fan,
        object: { id: `${rogue.origin}/activities/follow/${ctx.run}`, type: 'Follow', actor: fan, object: community.apId },
      });
    await rec.scenario('V2', 'rogue', async () => {
      try {
        await rogue.reset();

        // The rogue follows !lab as a Mastodon-like server and is accepted.
        let started = new Date();
        const follow = { id: `${rogue.origin}/activities/follow/${ctx.run}`, type: 'Follow', actor: fan, object: community.apId };
        const sent = await rogue.send(fan, follow);
        if (sent.status !== 202) throw new Error(`peblish answered the Follow ${sent.status}: ${sent.body}`);
        await expectInbound(ctx.sql, { since: started, actor: fan, type: 'Follow', contains: community.apId }, { state: 'applied' });
        await expectDelivery(ctx.sql, { since: started, type: 'Accept', host: 'rogue.lab.test' }, { state: 'delivered' });

        // A post: one Announce per inbox, bare Page to the Mastodon-like one and Create to the others.
        const title = tag(ctx, 'V2', { name: 'rogue' } as never);
        started = new Date();
        const post = await peblish.createPost('alice', community.id, { title, bodyMd: 'Seen by a Mastodon-like follower.' });
        ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: post.apId });
        await expectDelivery(
          ctx.sql,
          { since: started, type: 'Announce', host: 'rogue.lab.test', contains: title },
          { state: 'delivered' },
        );
        for (const peer of ctx.peers) {
          await expectDelivery(
            ctx.sql,
            { since: started, type: 'Announce', host: new URL(peer.origin).host, contains: title },
            { state: 'delivered' },
          );
        }
        const rows = await ctx.sql<{ inbox_url: string; forms: string[] }[]>`
        select inbox_url, array_agg(body::jsonb -> 'object' ->> 'type') as forms from deliveries
        where activity_type = 'Announce' and created_at >= ${started} and position(${title} in body) > 0 group by inbox_url`;
        for (const row of rows) {
          if (row.forms.length !== 1)
            throw new Error(`${row.inbox_url} got ${row.forms.length} Announces of the post: ${row.forms.join(', ')}`);
          const expected = new URL(row.inbox_url).host === 'rogue.lab.test' ? 'Page' : 'Create';
          if (row.forms[0] !== expected) throw new Error(`${row.inbox_url} got Announce(${row.forms[0]}), expected Announce(${expected})`);
        }
        const arrived = await waitFor('the rogue to receive the Announce', async () =>
          (await rogue.received()).find((r) => JSON.stringify(r.body).includes(title)),
        );
        const { type, inner } = typesOf(arrived.body);
        if (type !== 'Announce' || inner !== 'Page') throw new Error(`the rogue received ${type}(${inner})`);

        // FED-C: deleting the post sends the Mastodon-like follower Undo(Announce) and the author's Delete.
        const stored = await ctx.sql<{ id: string }[]>`select id from posts where ap_id = ${post.apId}`;
        await peblish.deletePost('alice', stored[0]!.id as never);
        const seen = await waitFor(
          'the rogue to hear of the delete',
          async () => {
            const got = (await rogue.received()).map((r) => typesOf(r.body)).filter((t) => t.type === 'Undo' || t.type === 'Delete');
            return got.length > 0 && got;
          },
          { timeoutMs: 15_000 },
        ).catch(() => []);
        const hasUndo = seen.some((t) => t.type === 'Undo' && t.inner === 'Announce');
        const hasDelete = seen.some((t) => t.type === 'Delete');
        if (!hasUndo || !hasDelete)
          throw new Pending(
            'FED-C',
            `Undo(Announce) ${hasUndo ? 'arrived' : 'missing'}, author Delete ${hasDelete ? 'arrived' : 'missing'} for the Mastodon-like follower`,
          );
        return 'Announce(Page) to the Mastodon-like follower, Announce(Create) to the peers, one per inbox; Undo(Announce) and Delete on removal';
      } finally {
        await unfollow().catch(() => undefined);
      }
    });
  },
};
