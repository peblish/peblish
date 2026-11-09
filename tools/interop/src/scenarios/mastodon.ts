// The rogue poses as Mastodon (its NodeInfo says so), so the lab has a Mastodon-like server.
//   V2  a follower there gets the bare Announce of the Page, threadiverse peers get
//       Announce(Create(Page)), no inbox gets both; deleting the post sends the follower
//       Undo(Announce) and the author's Delete.
//   V2/F5  a Lemmy admin's site ban of a Lemmy user with removeData takes back the local community's
//          boost of that user's post from the follower (Undo(Announce)).
//   V2/F3  a post that mentions a person there (not a follower), then removed by a moderator, is
//          taken back by the author's Delete sent to that person's server.
import type { Context, Group } from '../context.ts';
import { waitFor } from '../lab.ts';
import { expectDelivery, expectInbound } from '../match.ts';
import { peblish } from '../peblish.ts';
import { lemmy } from '../peers/threadiverse.ts';
import { rogue, typesOf, type Received } from '../rogue-client.ts';
import { storedPost, tag } from './support.ts';

/**
 * What reached the shared inbox of the rogue's people (mastofan's). The rogue's inbox fixtures
 * (/fixture/...) are left out: one may still follow !lab from an earlier group or run.
 */
const FOLLOWER_INBOX = `${rogue.origin}/inbox`;
const atInbox = async () => (await rogue.received()).filter((r) => r.path === '/inbox');

/** What the shared inbox received that names `apId`, as types. */
const heard = async (apId: string) =>
  (await atInbox()).filter((r) => JSON.stringify(r.body).includes(apId)).map((r) => ({ ...typesOf(r.body), body: r.body }));

/** The first activity at the shared inbox that `match` accepts, within the wait. */
const awaitRogue = (label: string, match: (r: Received) => boolean, timeoutMs = 45_000) =>
  waitFor(label, async () => (await atInbox()).find(match), { timeoutMs });

const objectOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? (body as { object?: unknown }).object : undefined;
const idOf = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : null;
const actorOf = (body: unknown): unknown => (typeof body === 'object' && body !== null ? (body as { actor?: unknown }).actor : undefined);

/** V2/F5: a Lemmy user's post boosted to the follower, then the user's site ban at home with removeData. */
async function f5(ctx: Context): Promise<string> {
  const username = `lf${ctx.run}`;
  await lemmy.registerUser!(username);
  const token = await lemmy.login(username);
  const onLemmy = await lemmy.resolveCommunity(token, ctx.community.handle);
  if (onLemmy.subscribed === 'NotSubscribed') await lemmy.follow(token, onLemmy.id);
  const title = tag(ctx, 'F5', { name: 'rogue' });
  const post = await lemmy.createPost(token, onLemmy.id, title, 'Boosted to Mastodon, then banned at home.');
  const entry = ctx.ledger.add({ kind: 'object', side: 'lemmy', user: username, type: 'post', apId: post.apId, peerId: post.id });
  await storedPost(ctx, post.apId);
  const boost = await awaitRogue(
    'the rogue to receive the boost',
    (r) => typesOf(r.body).type === 'Announce' && JSON.stringify(r.body).includes(title),
  );
  const boostId = idOf(boost.body);
  const adminToken = await lemmy.login(lemmy.admin);
  const personId = await lemmy.mod.resolvePerson(adminToken, lemmy.actorUri(username));
  const started = new Date();
  await lemmy.mod.siteBan!(adminToken, personId, true, `F5 ${ctx.run}`, true);
  // The ban removes the post on Lemmy, and a banned account cannot log in to delete it.
  ctx.ledger.done(entry, 'removed by the site ban');
  await expectInbound(
    ctx.sql,
    { since: started, actor: lemmy.actorUri(lemmy.admin), type: 'Block', contains: lemmy.actorUri(username) },
    { state: 'applied' },
  );
  await awaitRogue(
    'the rogue to receive Undo(Announce) of the boost',
    (r) => typesOf(r.body).type === 'Undo' && idOf(objectOf(r.body)) === boostId,
  );
  return `Lemmy's site ban with removeData applied; the boost ${boostId} was undone at the follower`;
}

/** V2/F3: alice names a person on the rogue (who follows nothing), and a moderator removes the post. */
async function f3(ctx: Context): Promise<string> {
  const person = rogue.actor('mastofan');
  const title = tag(ctx, 'F3', { name: 'rogue' });
  await rogue.reset();
  const created = await peblish.createPost('alice', ctx.community.id, { title, bodyMd: `For @mastofan@rogue.lab.test to see.` });
  const entry = ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: created.apId });
  const mention = await awaitRogue('the rogue to receive the mention', (r) => JSON.stringify(r.body).includes(created.apId));
  const { type, inner } = typesOf(mention.body);
  // Not a follower any more, so the only copy is the author's Create for the mention.
  if (type !== 'Create' || inner !== 'Page') throw new Error(`the mentioned person got ${type}(${inner}), expected Create(Page)`);
  if (!JSON.stringify(mention.body).includes(person)) throw new Error('the Create does not name the mentioned person');
  const stored = await storedPost(ctx, created.apId);
  await peblish.removePost('labadmin', stored.id, `F3 ${ctx.run}`);
  // A removed post is held for its retention, not deleted by its author.
  ctx.ledger.done(entry, 'removed by the scenario');
  const alice = await ctx.sql<{ ap_id: string }[]>`select ap_id from actors where local and name = 'alice'`;
  await awaitRogue(
    "the rogue to receive the author's Delete",
    (r) => typesOf(r.body).type === 'Delete' && idOf(objectOf(r.body)) === created.apId && actorOf(r.body) === alice[0]?.ap_id,
  );
  return "Create(Page) to the mentioned person; the moderator's removal reached them as the author's Delete";
}

export const mastodon: Group = {
  ids: ['V2', 'V2/F5', 'V2/F3'],
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
    try {
      await rec.scenario('V2', 'rogue', async () => {
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
        await expectDelivery(ctx.sql, { since: started, type: 'Announce', inbox: FOLLOWER_INBOX, contains: title }, { state: 'delivered' });
        for (const peer of ctx.peers) {
          await expectDelivery(
            ctx.sql,
            { since: started, type: 'Announce', host: new URL(peer.origin).host, contains: title },
            { state: 'delivered' },
          );
        }
        const rows = await ctx.sql<{ inbox_url: string; forms: string[] }[]>`
        select inbox_url, array_agg(body::jsonb -> 'object' ->> 'type') as forms from deliveries
        where activity_type = 'Announce' and created_at >= ${started} and position(${title} in body) > 0
          and inbox_url not like 'https://rogue.lab.test/fixture/%' group by inbox_url`;
        for (const row of rows) {
          if (row.forms.length !== 1)
            throw new Error(`${row.inbox_url} got ${row.forms.length} Announces of the post: ${row.forms.join(', ')}`);
          const expected = new URL(row.inbox_url).host === 'rogue.lab.test' ? 'Page' : 'Create';
          if (row.forms[0] !== expected) throw new Error(`${row.inbox_url} got Announce(${row.forms[0]}), expected Announce(${expected})`);
        }
        const arrived = await awaitRogue('the rogue to receive the Announce', (r) => JSON.stringify(r.body).includes(title));
        const { type, inner } = typesOf(arrived.body);
        if (type !== 'Announce' || inner !== 'Page') throw new Error(`the rogue received ${type}(${inner})`);

        // Deleting the post sends the Mastodon-like follower Undo(Announce) and the author's Delete.
        const stored = await ctx.sql<{ id: string }[]>`select id from posts where ap_id = ${post.apId}`;
        await peblish.deletePost('alice', stored[0]!.id as never);
        const seen = await waitFor(
          'the rogue to hear of the delete',
          async () => {
            const got = await heard(post.apId);
            const undo = got.some((t) => t.type === 'Undo' && t.inner === 'Announce');
            const deleted = got.some((t) => t.type === 'Delete');
            return undo && deleted && got;
          },
          { timeoutMs: 30_000 },
        ).catch(async () => heard(post.apId));
        const hasUndo = seen.some((t) => t.type === 'Undo' && t.inner === 'Announce');
        const hasDelete = seen.some((t) => t.type === 'Delete');
        if (!hasUndo || !hasDelete)
          throw new Error(
            `Undo(Announce) ${hasUndo ? 'arrived' : 'missing'}, author Delete ${hasDelete ? 'arrived' : 'missing'} for the Mastodon-like follower`,
          );
        return 'Announce(Page) to the Mastodon-like follower, Announce(Create) to the peers, one per inbox; Undo(Announce) and Delete on removal';
      });
      // V2/F5 (review finding F5) needs Lemmy (its site ban with removeData) and the follower still following.
      if (ctx.peers.some((peer) => peer.name === 'lemmy')) await rec.scenario('V2/F5', 'rogue', () => f5(ctx));
    } finally {
      const leaving = new Date();
      await unfollow().catch(() => undefined);
      // Applied before V2/F3 posts, or the post still goes to the follower too.
      await expectInbound(ctx.sql, { since: leaving, actor: fan, type: 'Undo' }, { state: 'applied' }).catch(() => undefined);
    }
    // V2/F3 (review finding F3) after the Undo(Follow): the mentioned person's server is reached only for the mention.
    await rec.scenario('V2/F3', 'rogue', () => f3(ctx));
  },
};
