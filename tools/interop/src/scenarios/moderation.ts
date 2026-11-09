// M1: moderation both ways.
//   M1/out    peblish's moderator removes, locks, features and bans; the peer shows each, then the undo.
//   M1/in     the peer's moderator does the same in the peer's community, which peblish follows;
//             peblish applies each from the community's Announce.
//   M1/remote a peer's user is made a moderator of !lab, moderates from its own server, and peblish
//             authorizes it against its moderator list, applies it and relays it.
import type { Uuid } from '@peblish/schema/ids';
import type { Context, Group } from '../context.ts';
import { HttpError, type KnownDefect, NotApplicable, sleep, waitFor } from '../lab.ts';
import { expectInbound } from '../match.ts';
import { seedAccount } from '@peblish/core/testing/seed-a';
import { actorIdByApId, apIdOf, localActorId, peblish } from '../peblish.ts';
import type { Peer } from '../peers/types.ts';
import { mbinUnannounced, peerOwnPostInPeblish, postOnPeer, prepare, type Side, storedPost, tag } from './support.ts';

async function canComment(peer: Peer, token: string, postId: number): Promise<boolean> {
  try {
    await peer.comment(token, postId, null, `ban probe ${Date.now()}`);
    return true;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

/** A post by the peer's user in !lab, stored in peblish and shown on the peer. */
async function peerPostInLab(ctx: Context, side: Side, label: string) {
  const post = await side.peer.createPost(side.token, side.labOnPeer, tag(ctx, label, side.peer), 'Moderation target.');
  ctx.ledger.add({ kind: 'object', side: side.peer.name, user: side.peer.user, type: 'post', apId: post.apId, peerId: post.id });
  const stored = await storedPost(ctx, post.apId);
  return { post, stored };
}

export const moderation: Group = {
  ids: ['M1'],
  async run(ctx) {
    const { rec, community } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);
      const peerUserId = await actorIdByApId(peer.actorUri(peer.user)).catch(() => null);

      // Mbin keeps a post trashed after the moderator restores it: the Undo(Delete) is not applied.
      const mbinRestore: KnownDefect | undefined =
        peer.name === 'mbin'
          ? {
              explanation: 'Mbin does not apply the Undo of a remote moderator\u2019s removal, so the post stays trashed',
              signature: 'timed out waiting for mbin to show removal undone',
            }
          : undefined;
      // M1/out: peblish moderates a peer user's post and the user.
      await rec.scenario(
        'M1/out',
        peer.name,
        async () => {
          const { post, stored } = await peerPostInLab(ctx, side, 'M1 out');
          const view = () => peer.getPost(side.token, post.id);
          const toggled: string[] = [];
          const toggle = async (name: string, on: () => Promise<unknown>, off: () => Promise<unknown>, probe: () => Promise<boolean>) => {
            await on();
            await waitFor(`${peer.name} to show ${name}`, probe, { timeoutMs: 30_000 });
            await off();
            await waitFor(`${peer.name} to show ${name} undone`, async () => !(await probe()), { timeoutMs: 30_000 });
            toggled.push(name);
          };
          await toggle(
            'removal',
            () => peblish.removePost('labadmin', stored.id, `M1 ${ctx.run}`),
            () => peblish.restorePost('labadmin', stored.id),
            async () => (await view()).removed,
          );
          await toggle(
            'lock',
            () => peblish.lock('labadmin', stored.id, true),
            () => peblish.lock('labadmin', stored.id, false),
            async () => (await view()).locked,
          );
          await toggle(
            'feature',
            () => peblish.pin('labadmin', stored.id, true),
            () => peblish.pin('labadmin', stored.id, false),
            async () => (await view()).featured,
          );
          const userId = peerUserId ?? (await actorIdByApId(peer.actorUri(peer.user)));
          const onPeer = await postOnPeer(side, side.labOnPeer, post.apId);
          await toggle(
            'community ban',
            () => peblish.ban('labadmin', community.id, userId, `M1 ${ctx.run}`),
            () => peblish.unban('labadmin', community.id, userId),
            async () => !(await canComment(peer, side.token, onPeer.id)),
          );
          // The ban dropped the user's subscription (Lemmy, PieFed); put it back for the scenarios after this.
          await peer.follow(side.token, side.labOnPeer).catch(() => undefined);
          return `${toggled.join(', ')} shown and undone on ${peer.name}`;
        },
        mbinRestore,
      );

      const pieFedUnban: KnownDefect | undefined =
        peer.name === 'piefed'
          ? {
              explanation: 'PieFed 1.8.11 never federates an unban, so peblish keeps the ban',
              signature: 'timed out waiting for peblish to lift the ban',
            }
          : undefined;
      // M1/in: the peer's moderator moderates a native post in the peer's community; peblish follows it.
      const nativeUnannounced: KnownDefect | undefined = peer.name === 'mbin' ? mbinUnannounced(side.remote.apId) : undefined;
      await rec.scenario(
        'M1/in',
        peer.name,
        async () => {
          const native = await peerOwnPostInPeblish(ctx, side, tag(ctx, 'M1 in', peer));
          const community = side.remote;
          const sinceAll = new Date();
          const row = (apId: string) =>
            ctx.sql<Record<string, unknown>[]>`
            select removed_at, locked, featured_community from posts where ap_id = ${apId}`.then((r) => r[0]);
          const steps: { name: string; act: () => Promise<void>; state: () => Promise<boolean>; contains: string }[] = [
            {
              name: 'remove',
              act: () => peer.mod.removePost(side.adminToken, native.post.id, true, `M1 ${ctx.run}`),
              state: async () => (await row(native.post.apId))?.removed_at != null,
              contains: native.post.apId,
            },
            {
              name: 'restore',
              act: () => peer.mod.removePost(side.adminToken, native.post.id, false, `M1 ${ctx.run}`),
              state: async () => (await row(native.post.apId))?.removed_at == null,
              contains: native.post.apId,
            },
            {
              name: 'lock',
              act: () => peer.mod.lockPost(side.adminToken, native.post.id, true),
              state: async () => (await row(native.post.apId))?.locked === true,
              contains: native.post.apId,
            },
            {
              name: 'unlock',
              act: () => peer.mod.lockPost(side.adminToken, native.post.id, false),
              state: async () => (await row(native.post.apId))?.locked === false,
              contains: native.post.apId,
            },
            {
              name: 'feature',
              act: () => peer.mod.featurePost(side.adminToken, native.post.id, true),
              state: async () => (await row(native.post.apId))?.featured_community === true,
              contains: native.post.apId,
            },
            {
              name: 'unfeature',
              act: () => peer.mod.featurePost(side.adminToken, native.post.id, false),
              state: async () => (await row(native.post.apId))?.featured_community === false,
              contains: native.post.apId,
            },
          ];
          const done: string[] = [];
          for (const step of steps) {
            const started = new Date();
            await step.act();
            await expectInbound(
              ctx.sql,
              { since: started, type: 'Announce', actor: community.apId, contains: step.contains },
              { state: 'applied' },
            );
            await waitFor(`peblish to apply ${step.name}`, step.state, { timeoutMs: 15_000 });
            done.push(step.name);
          }
          // A ban of a peblish user, then its undo.
          // A new local user each run: a ban PieFed never lifts must not stand in the way of the next run.
          const target = `m1${ctx.run}${peer.name}`;
          await seedAccount(target);
          const bob = await localActorId('Person', target);
          const targetUri = await apIdOf('actors', bob);
          const personId = await peer.mod.resolvePerson(side.adminToken, targetUri);
          const banned = async () =>
            (await ctx.sql`select 1 from community_bans where community_id = ${community.id} and actor_id = ${bob}`).length > 0;
          let started = new Date();
          await peer.mod.ban(side.adminToken, side.peerCommunityId, personId, true, `M1 ${ctx.run}`);
          await expectInbound(
            ctx.sql,
            { since: started, type: 'Announce', actor: community.apId, contains: targetUri },
            { state: 'applied' },
          );
          await waitFor('peblish to record the ban', banned, { timeoutMs: 15_000 });
          started = new Date();
          await peer.mod.ban(side.adminToken, side.peerCommunityId, personId, false, `M1 ${ctx.run}`);
          await waitFor('peblish to lift the ban', async () => !(await banned()), { timeoutMs: 15_000 });
          done.push('ban', 'unban');
          void sinceAll;
          return `${done.join(', ')} applied from ${peer.name}'s Announces`;
        },
        nativeUnannounced ?? pieFedUnban,
      );

      // M1/remote: the peer's user becomes a moderator of !lab and moderates it from the peer's own server.
      await rec.scenario('M1/remote', peer.name, async () => {
        if (peer.name === 'mbin')
          throw new NotApplicable('Mbin API users are bots, stored as Service actors; a peblish moderator is a Person');
        const userId = peerUserId ?? (await actorIdByApId(peer.actorUri(peer.user)));
        const modUri = peer.actorUri(peer.user);
        await peblish.setModerator('labadmin', community.id, userId, 'moderator');
        const listed = (token: string) => peer.mod.moderators(token, side.labOnPeer).then((m) => m.includes(modUri));
        try {
          // PieFed applies the Add to its database but its API serves a cached moderator list that a
          // federated Add does not invalidate, so only the others are asked for the listing; the
          // removal below shows whether the new moderator has the rights.
          if (peer.name !== 'piefed')
            await waitFor(`${peer.name} to list ${peer.user} as a moderator of !lab`, () => listed(side.token), { timeoutMs: 60_000 });
          else await sleep(3_000);
          const { post, stored } = await peerPostInLab(ctx, side, 'M1 remote');
          const started = new Date();
          await peer.mod.removePost(side.token, post.id, true, `M1 remote ${ctx.run}`);
          await expectInbound(ctx.sql, { since: started, actor: modUri, contains: post.apId }, { state: 'applied' });
          await waitFor(
            'peblish to hold the removal',
            async () => (await ctx.sql`select 1 from posts where id = ${stored.id as Uuid} and removed_at is not null`).length > 0,
            { timeoutMs: 15_000 },
          );
        } finally {
          await peblish.setModerator('labadmin', community.id, userId, null);
        }
        if (peer.name !== 'piefed')
          await waitFor(`${peer.name} to drop ${peer.user} as a moderator`, async () => !(await listed(side.token)), { timeoutMs: 60_000 });
        return `${peer.user} added as a moderator, removed a post from ${peer.name}, then dropped`;
      });
    }
  },
};
