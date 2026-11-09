// S1: instance-wide bans both ways.
//   S1/out  a peblish admin site-bans a peer's user: the user's next post in !lab is refused as
//           auth.site_banned, and the Block (the instance as target) and the unban's Undo(Block)
//           reach the peer (Lemmy answers both 400: a remote instance's ban never touches a
//           user at home, so it refuses one aimed at its own user).
//   S1/in   the peer's admin site-bans one of the peer's own users: peblish applies the Block as
//           that peer's ban (site_bans, source remote), then lifts it on the Undo.
import type { Uuid } from '@peblish/schema/ids';
import type { Group } from '../context.ts';
import { type KnownDefect, NotApplicable, waitFor } from '../lab.ts';
import { expectDelivery, expectInbound, type Sql } from '../match.ts';
import { actorIdByApId, peblish, postByApId } from '../peblish.ts';
import { prepare, tag } from './support.ts';

const siteBan = (ctx: { sql: Sql }, actorId: Uuid) =>
  ctx.sql<
    { source: string; activity_ap_id: string | null }[]
  >`select source, activity_ap_id from site_bans where actor_id = ${actorId}`.then((rows) => rows[0] ?? null);

const LEMMY_HOME_RULE = "Site bans from remote instance can't affect user's home instance";

export const bans: Group = {
  ids: ['S1'],
  async run(ctx) {
    const { rec } = ctx;
    for (const peer of ctx.peers) {
      const side = await prepare(ctx, peer);
      const host = new URL(peer.origin).host;

      // Lemmy refuses a ban of one of its own people by another instance, by design; elsewhere the
      // Block and its Undo are delivered.
      const reached = async (type: 'Block' | 'Undo', since: Date, userApId: string) => {
        const query = { since, type, host, contains: userApId };
        if (peer.name !== 'lemmy') return expectDelivery(ctx.sql, query, { state: 'delivered' });
        const row = await expectDelivery(ctx.sql, query, { state: 'failed', status: 400 });
        if (!row.error?.includes(LEMMY_HOME_RULE)) throw new Error(`Lemmy refused the ${type} otherwise: ${row.error}`);
        return row;
      };
      await rec.scenario('S1/out', peer.name, async () => {
        if (peer.name === 'mbin') throw new NotApplicable('Mbin API users are bots, stored as Service actors; a site ban is of a Person');
        const userApId = peer.actorUri(peer.user);
        const userId = await actorIdByApId(userApId);
        const banned = new Date();
        await peblish.siteBan('labadmin', userId, `S1 ${ctx.run}`);
        let lifted: Date;
        try {
          const title = tag(ctx, 'S1 banned', peer);
          const posted = new Date();
          const post = await peer.createPost(side.token, side.labOnPeer, title, 'Posted while banned on peblish.');
          ctx.ledger.add({ kind: 'object', side: peer.name, user: peer.user, type: 'post', apId: post.apId, peerId: post.id });
          await expectInbound(
            ctx.sql,
            { since: posted, actor: userApId, type: 'Create', contains: title },
            { state: 'skipped', reason: 'auth.site_banned' },
          );
          if (await postByApId(post.apId)) throw new Error('the banned user’s post was stored');
        } finally {
          lifted = new Date();
          await peblish.siteUnban('labadmin', userId);
        }
        await reached('Block', banned, userApId);
        await reached('Undo', lifted, userApId);
        return peer.name === 'lemmy'
          ? 'the banned user’s post refused as auth.site_banned; Lemmy answered the Block and its Undo 400, as it does for a remote ban of its own user'
          : 'the banned user’s post refused as auth.site_banned; the Block and its Undo delivered';
      });

      // PieFed 1.8.11 sends a site ban only to instances whose NodeInfo software is piefed, pylova,
      // lemmy or mbin (ban_person in its tasks), and peblish's is peblish.
      const pieFedSoftware: KnownDefect | undefined =
        peer.name === 'piefed'
          ? {
              explanation: 'PieFed 1.8.11 sends a site ban only to piefed, pylova, lemmy and mbin instances, so peblish never hears of it',
              signature: `no inbox row for Block from ${peer.actorUri(peer.admin)}`,
            }
          : undefined;
      await rec.scenario(
        'S1/in',
        peer.name,
        async () => {
          const ban = peer.mod.siteBan;
          if (!ban)
            throw new NotApplicable('a site ban on Mbin needs the admin:user:ban scope, and the lab’s bot clients ask for no admin scope');
          // A throwaway account where the peer can make one, so the ban leaves the seeded user alone.
          const username = peer.registerUser ? `ls${ctx.run}` : peer.user;
          if (peer.registerUser) await peer.registerUser(username);
          const token = await peer.login(username);
          const onPeer = await peer.resolveCommunity(token, ctx.community.handle);
          if (onPeer.subscribed === 'NotSubscribed') await peer.follow(token, onPeer.id);
          const userApId = peer.actorUri(username);
          // peblish learns the account from a post in !lab.
          const post = await peer.createPost(token, onPeer.id, tag(ctx, 'S1 in', peer), 'About to be banned at home.');
          ctx.ledger.add({ kind: 'object', side: peer.name, user: username, type: 'post', apId: post.apId, peerId: post.id });
          const userId = await waitFor(`peblish to learn ${userApId}`, () => actorIdByApId(userApId).catch(() => null));
          const personId = await peer.mod.resolvePerson(side.adminToken, userApId);
          const started = new Date();
          await ban(side.adminToken, personId, true, `S1 ${ctx.run}`, false);
          try {
            await expectInbound(
              ctx.sql,
              { since: started, actor: peer.actorUri(peer.admin), type: 'Block', contains: userApId },
              { state: 'applied' },
            );
            const held = await waitFor('peblish to record the peer’s site ban', () => siteBan(ctx, userId), { timeoutMs: 15_000 });
            if (held.source !== 'remote') throw new Error(`the site ban is ${held.source}, expected remote`);
          } finally {
            await ban(side.adminToken, personId, false, `S1 ${ctx.run}`, false);
          }
          await waitFor('peblish to lift the site ban', async () => (await siteBan(ctx, userId)) === null, { timeoutMs: 30_000 });
          return `${username}’s ban by ${peer.name} applied as the peer’s own, and lifted`;
        },
        pieFedSoftware,
      );
    }
  },
};
