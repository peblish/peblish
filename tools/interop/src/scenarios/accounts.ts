// S2: account deletion both ways. A peblish account's deletion reaches each peer; a Lemmy
// user's deletion, with and without "delete my content", reaches peblish and lands in the
// deletion ledger as `remote.actor_deleted`.
import { seedAccount } from '@peblish/core/testing/seed-a';
import type { Group } from '../context.ts';
import { type KnownDefect, NotApplicable, PASSWORD, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { postOnPeer, prepare, storedPost, tag } from './support.ts';

export const accounts: Group = {
  ids: ['S2'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);

      // S2/out: a peblish user posts, deletes the account, and the Delete reaches the peer.
      // Lemmy keeps a deleted person's posts unless the Delete says `removeData`, which peblish's does not.
      const lemmyKeeps: KnownDefect | undefined =
        peer.name === 'lemmy'
          ? {
              explanation: "peblish's account Delete carries no removeData, so Lemmy keeps the account's posts visible",
              signature: "timed out waiting for lemmy to hide the deleted account's post",
            }
          : undefined;
      await rec.scenario(
        'S2/out',
        peer.name,
        async () => {
          const name = `gone${ctx.run}${peer.name}`;
          await seedAccount(name, { password: PASSWORD });
          const created = await peblish.createPost(name, community.id, { title: tag(ctx, 'S2', peer), bodyMd: 'Soon gone.' });
          const onPeer = await postOnPeer(side, side.labOnPeer, created.apId);
          const started = new Date();
          await peblish.deleteAccount(name);
          await expectDelivery(ctx.sql, { since: started, type: 'Delete', host: new URL(peer.origin).host }, { state: 'delivered' });
          await waitFor(`${peer.name} to hide the deleted account's post`, async () => {
            const post = await peer.getPost(side.token, onPeer.id).catch(() => null);
            return !post || post.deleted || post.removed;
          });
          return 'the deleted account’s Delete reached the peer and its post is gone there';
        },
        lemmyKeeps,
      );

      // S2/in: a Lemmy user posts in !lab and deletes the account; peblish records remote.actor_deleted.
      for (const withContent of [false, true]) {
        const id = withContent ? 'S2/in+content' : 'S2/in';
        await rec.scenario(id, peer.name, async () => {
          if (!peer.registerUser) {
            throw new NotApplicable(
              peer.name === 'piefed'
                ? 'PieFed deletes an account through its settings form only; the API stub does nothing'
                : 'Mbin deletes an account by console command only; not driven from the runner',
            );
          }
          const username = `lg${withContent ? 'c' : 'n'}${ctx.run}`;
          await peer.registerUser(username);
          const token = await peer.login(username);
          const onPeer = await peer.resolveCommunity(token, ctx.community.handle);
          await peer.follow(token, onPeer.id);
          const post = await peer.createPost(token, onPeer.id, tag(ctx, `S2 ${id}`, peer), 'Posted by an account about to go.');
          const stored = await storedPost(ctx, post.apId);
          const actorApId = peer.actorUri(username);
          const started = new Date();
          await peer.deleteAccount(token, PASSWORD, withContent);
          await expectInbound(ctx.sql, { since: started, actor: actorApId, type: 'Delete' }, { state: 'applied' });
          const ledger = await waitFor('the remote.actor_deleted ledger row', async () => {
            const rows = await ctx.sql<{ details: { removeContent?: boolean } }[]>`
              select details from deletion_ledger where subject_kind = 'actor' and subject_ap_id = ${actorApId} and reason = 'remote.actor_deleted'`;
            return rows[0];
          });
          if (Boolean(ledger.details.removeContent) !== withContent) {
            throw new Error(`removeContent is ${String(ledger.details.removeContent)}, expected ${withContent}`);
          }
          const [after] = await ctx.sql<{ deleted_at: Date | null }[]>`select deleted_at from posts where id = ${stored.id}`;
          if (withContent && !after?.deleted_at) throw new Error('the deleted account’s post is still alive in peblish');
          if (!withContent && after?.deleted_at) throw new Error('the post was deleted without "delete my content"');
          return withContent ? 'actor deleted with its content' : 'actor deleted, content kept';
        });
      }
    }
  },
};
