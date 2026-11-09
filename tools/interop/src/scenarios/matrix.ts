// Z1: the authorization matrix (N0 to N15) from the rogue peer through the real inbox. The rogue
// signs each activity with a real key, so a refusal comes from peblish's rules and not from a bad
// signature (N0 is the control that it can deliver at all). The reasons are those of
// packages/federation/src/inbound/matrix.test.ts, which runs the same cases against fixtures.
import { randomUUID } from 'node:crypto';
import type { Context } from '../context.ts';
import { expectInbound, type InboxExpectation } from '../match.ts';
import { actorIdByApId, peblish } from '../peblish.ts';
import { rogue } from '../rogue-client.ts';
import type { Group } from '../context.ts';
import { sleep } from '../lab.ts';
import { peerOwnPostInPeblish, prepare, tag } from './support.ts';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** What a refused attempt must leave alone: flags on every post, and the number of comments, votes, bans and moderators. */
async function snapshot(ctx: Context): Promise<string> {
  const posts = await ctx.sql`select ap_id, title, locked, featured_community, removed_at, deleted_at from posts order by ap_id`;
  const [counts] = await ctx.sql<{ comments: number; votes: number; bans: number; moderators: number }[]>`
    select (select count(*) from comments)::int as comments, (select count(*) from votes)::int as votes,
           (select count(*) from community_bans)::int as bans, (select count(*) from community_moderators)::int as moderators`;
  return JSON.stringify({ posts, counts });
}

export const matrix: Group = {
  ids: ['Z1'],
  async run(ctx) {
    const { rec, community } = ctx;
    const mallory = rogue.actor('mallory');
    const fake = rogue.group('fake');
    const rid = (type: string) => `${rogue.origin}/activities/${type}/${randomUUID()}`;
    const addressed = (to: string) => ({ to: [PUBLIC], cc: [to], audience: to });
    const local = addressed(community.apId);

    // A peer to stand for "another server's person and community": the first one that announces its own posts.
    const sides = [];
    for (const peer of ctx.peers) sides.push(await prepare(ctx, peer));
    const side = sides.find((s) => s.peer.name !== 'mbin') ?? sides[0];
    const remoteActor = side ? side.peer.actorUri(side.peer.user) : 'https://lemmy.lab.test/u/lemmyuser';
    const remoteOrigin = side ? side.peer.origin : 'https://lemmy.lab.test';

    // T1 is a local post, T2 a post in a remote community peblish follows. The rogue's group is followed too.
    const t1 = await peblish.createPost('alice', community.id, { title: tag(ctx, 'Z1 T1', { name: 'rogue' }), bodyMd: 'Target in !lab.' });
    ctx.ledger.add({ kind: 'object', side: 'peblish', user: 'alice', type: 'post', apId: t1.apId });
    const t2 = side && side.peer.name !== 'mbin' ? (await peerOwnPostInPeblish(ctx, side, tag(ctx, 'Z1 T2', side.peer))).post.apId : null;
    const remoteCommunity = side?.remote.apId ?? null;
    await peblish.followRemote('alice', fake).catch(() => undefined);
    await sleep(2_000);

    const send = async (id: string, as: string, activity: Record<string, unknown>) => {
      const started = new Date();
      const response = await rogue.send(as, { id, ...activity });
      return { started, response };
    };

    /** Sends, expects 202, waits for the row, and checks that nothing changed. */
    const refuse = async (
      caseId: string,
      title: string,
      as: string,
      activity: Record<string, unknown>,
      expected: InboxExpectation,
      options: { type?: string; contains?: string } = {},
    ) =>
      rec.scenario(`Z1/${caseId}`, 'rogue', async () => {
        const before = await snapshot(ctx);
        const id = rid(String(activity.type).toLowerCase());
        const { started, response } = await send(id, as, activity);
        if (response.status !== 202) throw new Error(`peblish answered ${response.status}: ${response.body}`);
        await expectInbound(
          ctx.sql,
          { since: started, type: options.type ?? String(activity.type), contains: options.contains ?? id },
          expected,
        );
        if (expected.state !== 'applied' && (await snapshot(ctx)) !== before) throw new Error('state changed');
        return title;
      });

    const note = (inReplyTo: string, id: string) => ({
      id: `${rogue.origin}/comment/${id}`,
      type: 'Note',
      attributedTo: mallory,
      inReplyTo,
      content: '<p>hello</p>',
      to: [PUBLIC],
      cc: [community.apId],
      audience: community.apId,
    });

    // N0: the control. A signed comment from the rogue applies.
    await refuse(
      'N0',
      'a signed comment from the rogue applies',
      mallory,
      { type: 'Create', actor: mallory, object: note(t1.apId, randomUUID()), ...local },
      { state: 'applied' },
    );

    // Direct, by a person who moderates nothing.
    await refuse(
      'N1',
      'a non-moderator removes a post',
      mallory,
      { type: 'Delete', actor: mallory, object: t1.apId, summary: 'spam', ...local },
      { state: 'skipped', reason: 'mod.moderator_required' },
    );
    await refuse(
      'N2',
      'a non-author edits a post',
      mallory,
      {
        type: 'Update',
        actor: mallory,
        ...local,
        object: {
          id: t1.apId,
          type: 'Page',
          attributedTo: mallory,
          name: 'hijacked',
          content: '<p>hijacked</p>',
          audience: community.apId,
          to: [community.apId, PUBLIC],
        },
      },
      { state: 'skipped', reason: 'object.origin_mismatch', detail: '*' },
    );
    await refuse(
      'N3',
      'a non-moderator locks a post',
      mallory,
      { type: 'Lock', actor: mallory, object: t1.apId, ...local },
      { state: 'skipped', reason: 'mod.moderator_required' },
    );
    await refuse(
      'N4',
      'a non-moderator features a post',
      mallory,
      { type: 'Add', actor: mallory, object: t1.apId, target: `${community.apId}/featured`, ...local },
      { state: 'skipped', reason: 'mod.moderator_required' },
    );
    await refuse(
      'N5',
      'a non-moderator bans a user',
      mallory,
      { type: 'Block', actor: mallory, object: remoteActor, target: community.apId, ...local },
      { state: 'skipped', reason: 'mod.moderator_required' },
    );
    await refuse(
      'N6',
      'a non-moderator makes itself a moderator',
      mallory,
      { type: 'Add', actor: mallory, object: mallory, target: `${community.apId}/moderators`, ...local },
      { state: 'skipped', reason: 'moderators.local_collection', detail: community.apId },
    );
    await refuse(
      'N7',
      "an undo of another actor's vote",
      mallory,
      {
        type: 'Undo',
        actor: mallory,
        ...local,
        object: { id: rid('like'), type: 'Like', actor: remoteActor, object: t1.apId, audience: community.apId },
      },
      { state: 'skipped', reason: 'embedded.actor_mismatch', detail: '*' },
    );
    if (t2 && remoteCommunity) {
      await refuse(
        'N8',
        'a report on content in another server’s community',
        mallory,
        { type: 'Flag', actor: mallory, object: t2, summary: 'not yours to judge', to: [remoteCommunity] },
        { state: 'skipped', reason: 'report.not_local', detail: t2 },
      );
    }

    // N9: signed with mallory's key but claiming another actor. The HTTP signature check answers 401.
    await rec.scenario('Z1/N9', 'rogue', async () => {
      const before = await snapshot(ctx);
      const { response } = await send(rid('delete'), mallory, { type: 'Delete', actor: remoteActor, object: t1.apId, ...local });
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}: ${response.body}`);
      if ((await snapshot(ctx)) !== before) throw new Error('state changed');
      return 'Delete claiming another actor, signed with mallory’s key -> 401';
    });

    // Forged Announces from a group peblish follows.
    const announce = (object: Record<string, unknown>, actor = fake) => ({
      type: 'Announce',
      actor,
      to: [PUBLIC],
      cc: [`${actor}/followers`],
      object,
    });
    if (t2 && remoteCommunity) {
      const inner10 = {
        id: rid('delete'),
        type: 'Delete',
        actor: remoteActor,
        object: t2,
        to: [PUBLIC],
        cc: [remoteCommunity],
        audience: remoteCommunity,
      };
      await refuse(
        'N10',
        'a followed group announces a Delete with its own origin but another server’s author',
        fake,
        announce(inner10),
        { state: 'skipped', reason: 'activity.origin_mismatch', detail: '*' },
        { contains: inner10.id },
      );
      const inner11 = {
        id: `${remoteOrigin}/activities/delete/${randomUUID()}`,
        type: 'Delete',
        actor: remoteActor,
        object: t2,
        to: [PUBLIC],
        cc: [remoteCommunity],
        audience: remoteCommunity,
      };
      await refuse(
        'N11',
        'a followed group announces a Delete claiming an id its origin does not serve',
        fake,
        announce(inner11),
        { state: 'skipped', reason: 'embedded.unverifiable', detail: '*' },
        { contains: inner11.id },
      );
    }
    {
      const page = {
        id: `${rogue.origin}/post/${randomUUID()}`,
        type: 'Page',
        attributedTo: mallory,
        name: 'smuggled',
        content: '<p>smuggled</p>',
        audience: remoteCommunity ?? 'https://lemmy.lab.test/c/lab',
        to: [remoteCommunity ?? 'https://lemmy.lab.test/c/lab', PUBLIC],
      };
      const inner = {
        id: rid('create'),
        type: 'Create',
        actor: mallory,
        object: page,
        to: [PUBLIC],
        cc: [remoteCommunity ?? 'https://lemmy.lab.test/c/lab'],
        audience: remoteCommunity ?? 'https://lemmy.lab.test/c/lab',
      };
      await refuse(
        'N12',
        'a group announces a post addressed to a community it does not own',
        fake,
        announce(inner),
        { state: 'skipped', reason: 'mod.announce_mismatch' },
        { contains: inner.id },
      );
    }
    await refuse(
      'N13',
      'an Announce from an actor that is not a community',
      mallory,
      announce({ id: rid('delete'), type: 'Delete', actor: mallory, object: t1.apId, to: [PUBLIC] }, mallory),
      { state: 'skipped', reason: 'announce.person', detail: mallory },
    );

    // Community rules: a ban and a lock.
    const malloryId = await actorIdByApId(mallory);
    await peblish.ban('labadmin', community.id, malloryId, `Z1 ${ctx.run}`);
    try {
      await refuse(
        'N14',
        'a user banned from the community comments',
        mallory,
        { type: 'Create', actor: mallory, object: note(t1.apId, randomUUID()), ...local },
        { state: 'skipped', reason: 'community.banned' },
      );
    } finally {
      await peblish.unban('labadmin', community.id, malloryId);
    }
    const t1Row = await ctx.sql<{ id: string }[]>`select id from posts where ap_id = ${t1.apId}`;
    await peblish.lock('labadmin', t1Row[0]!.id as never, true, `Z1 ${ctx.run}`);
    try {
      await refuse(
        'N15',
        'a comment on a locked post',
        mallory,
        { type: 'Create', actor: mallory, object: note(t1.apId, randomUUID()), ...local },
        { state: 'skipped', reason: 'post.locked' },
      );
    } finally {
      await peblish.lock('labadmin', t1Row[0]!.id as never, false, `Z1 ${ctx.run}`);
    }
  },
};
