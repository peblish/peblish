// C1, C2: comments both ways, threaded, edited and deleted.
import type { Group } from '../context.ts';
import { HttpError, type KnownDefect, waitFor } from '../lab.ts';
import { expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { commentOnPeer, mbinUnannounced, peerOwnPostInPeblish, postOnPeer, prepare, storedComment, storedPost, tag } from './support.ts';

export const comments: Group = {
  ids: ['C1', 'C2'],
  async run(ctx) {
    const { rec, community } = ctx;
    const [alice] = await ctx.sql<{ ap_id: string }[]>`select ap_id from actors where local and name = 'alice'`;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);

      // Mbin addresses a comment's Delete to the post's author first and the community second, and
      // peblish takes the first addressee for the community: the Delete is skipped and the comment stays.
      const mbinDelete: KnownDefect | undefined =
        peer.name === 'mbin' && alice
          ? {
              explanation:
                "a peer's Delete of its comment on another origin's post is skipped: Mbin lists the post author before the community",
              signature: `got [skipped community.mismatch ${alice.ap_id} is not ${community.apId}]`,
            }
          : undefined;

      // C1: into peblish. The peer's user comments on alice's post, alice replies, the user edits and deletes.
      await rec.scenario(
        'C1',
        peer.name,
        async () => {
          const title = tag(ctx, 'C1', peer);
          const post = await peblish.createPost('alice', community.id, { title, bodyMd: 'A post to comment on.' });
          ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: post.apId });
          const onPeer = await postOnPeer(side, side.labOnPeer, post.apId);

          const started = new Date();
          const comment = await peer.comment(side.token, onPeer.id, null, `Top comment from ${peer.name} ${ctx.run}`);
          ctx.ledger.add({ kind: 'object', side: peer.name, user: peer.user, type: 'comment', apId: comment.apId, peerId: comment.id });
          await expectInbound(
            ctx.sql,
            { since: started, actor: peer.actorUri(peer.user), type: 'Create', contains: comment.apId },
            { state: 'applied' },
          );
          const stored = await storedComment(ctx, comment.apId);
          if (stored.parent_id !== null) throw new Error('the top comment has a parent');

          const reply = await peblish.comment(
            'alice',
            { postId: (await storedPost(ctx, post.apId)).id, parentId: stored.id },
            'Reply from alice.',
          );
          ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'comment', apId: reply.apId });
          const replyOnPeer = await commentOnPeer(side, onPeer.id, reply.apId);
          if (replyOnPeer.parentId !== comment.id) throw new Error(`the reply's parent is ${replyOnPeer.parentId}, expected ${comment.id}`);

          await peer.editComment(side.token, comment.id, `Edited by ${peer.name} ${ctx.run}`);
          await waitFor('peblish to show the edit', async () => {
            const [row] = await ctx.sql<{ body_md: string | null }[]>`select body_md from comments where ap_id = ${comment.apId}`;
            return row?.body_md?.includes('Edited by') && row;
          });

          // Last, because it is where the known Mbin defect shows.
          const deleting = new Date();
          await peer.deleteComment(side.token, comment.id);
          await expectInbound(
            ctx.sql,
            { since: deleting, actor: peer.actorUri(peer.user), type: 'Delete', contains: comment.apId },
            { state: 'applied' },
          );
          await waitFor('peblish to show the delete', async () => {
            const [row] = await ctx.sql<{ deleted_at: Date | null }[]>`select deleted_at from comments where ap_id = ${comment.apId}`;
            return row?.deleted_at && row;
          });
          return 'comment, reply, edit and delete into peblish, parents kept';
        },
        mbinDelete,
      );

      // C2: out of peblish. alice replies to a post in the peer's community, the peer answers, alice edits and deletes.
      await rec.scenario(
        'C2',
        peer.name,
        async () => {
          const { post: theirs, stored: theirStored } = await peerOwnPostInPeblish(ctx, side, tag(ctx, 'C2 theirs', peer));
          const aliceTop = await peblish.comment('alice', { postId: theirStored.id }, `Alice on ${peer.name}'s post.`);
          ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'comment', apId: aliceTop.apId });
          const aliceOnPeer = await commentOnPeer(side, theirs.id, aliceTop.apId);
          const peerReply = await peer.comment(side.adminToken, theirs.id, aliceOnPeer.id, `Answer from ${peer.name}'s admin.`);
          ctx.ledger.add({
            kind: 'object',
            side: peer.name,
            user: peer.admin,
            type: 'comment',
            apId: peerReply.apId,
            peerId: peerReply.id,
          });
          const storedReply = await storedComment(ctx, peerReply.apId);
          if (storedReply.parent_id === null) throw new Error("the peer's reply was stored without a parent");

          await peblish.editComment('alice', (await storedComment(ctx, aliceTop.apId)).id, `Alice edits ${ctx.run}`);
          await waitFor(`${peer.name} to show alice's edit`, async () =>
            (await peer.listComments(side.token, theirs.id)).find((c) => c.apId === aliceTop.apId && c.content.includes('Alice edits')),
          );
          await peblish.deleteComment('alice', (await storedComment(ctx, aliceTop.apId)).id);
          await waitFor(`${peer.name} to hide alice's comment`, async () => {
            const list = await peer.listComments(side.token, theirs.id).catch((error: unknown) => {
              if (error instanceof HttpError) return [];
              throw error;
            });
            const found = list.find((c) => c.apId === aliceTop.apId);
            return !found || found.deleted || found.removed;
          });
          return 'comment, reply, edit and delete out of peblish, parents kept';
        },
        peer.name === 'mbin' ? mbinUnannounced(side.remote.apId) : undefined,
      );
    }
  },
};
