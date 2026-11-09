import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts, votes } from '@peblish/core/db/tables/content';
import { communityBans } from '@peblish/core/moderation/tables';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedBan } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { signDelivery } from '../signing/sign.ts';
import { receiveInbound } from './receive.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { processRow, type PipelineOptions } from './pipeline.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC, useCommentDouble } from './test-support.ts';

const deliver = (json: Record<string, unknown>, options: PipelineOptions = {}) => deliverRow(json, (row) => processRow(row, options));

// The authorization matrix of the Phase 0 spike (scenarios/authz.ts): one control that must
// apply (N0) and fifteen attempts that must not (N1 to N15). Each case names the exact reason,
// because a refusal for the wrong reason would let the check it names be deleted unnoticed
// (spike review finding 8), and asserts that nothing changed.

type World = Awaited<ReturnType<typeof seedInboundWorld>>;
type Outcome = { state: string; error: string | null } | { status: number };
type Json = Record<string, unknown>;

const { spike, lab, lemmyuser, mallory, fake, t1, t2 } = hosts;
const rogue = 'https://rogue.test';
const note = (id: string) => ({
  id: `${rogue}/comment/${id}`,
  type: 'Note',
  attributedTo: mallory,
  inReplyTo: t1,
  content: '<p>hello</p>',
  to: [PUBLIC],
  cc: [spike],
  audience: spike,
});
const create = (object: Json, actor = mallory) => ({
  id: activityId(rogue, 'create'),
  type: 'Create',
  actor,
  object,
  ...addressedToCommunity(spike),
});
const announce = (inner: Json, actor: string = fake) => ({
  id: activityId(rogue, 'announce'),
  type: 'Announce',
  actor,
  to: [PUBLIC],
  cc: [`${actor}/followers`],
  object: inner,
});

/** What a refused attempt must leave alone: the posts' flags, the comments, votes, bans and moderators. */
async function snapshot() {
  const flags = await db()
    .select({
      id: posts.id,
      title: posts.title,
      locked: posts.locked,
      featured: posts.featuredCommunity,
      removedAt: posts.removedAt,
      deletedAt: posts.deletedAt,
    })
    .from(posts)
    .orderBy(posts.apId);
  const count = async (table: typeof comments | typeof votes | typeof communityBans | typeof communityModerators) =>
    (
      await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
    )[0]?.n;
  return JSON.stringify({
    flags,
    comments: await count(comments),
    votes: await count(votes),
    bans: await count(communityBans),
    moderators: await count(communityModerators),
  });
}

let world: World;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
  await writer().insert(votes).values({
    apId: 'https://lemmy.test/activities/like/seed',
    local: false,
    instanceId: world.instances.lemmy.id,
    voterId: world.peers.lemmyuser.id,
    postId: world.t1.id,
    value: 1,
  });
});

type Case = {
  id: string;
  title: string;
  expected: { state: 'applied' } | { state: 'skipped'; error: string } | { status: number };
  /** Runs the attempt; the world is seeded, and `before` is its state when this runs. */
  run: (w: World) => Promise<Outcome>;
  setup?: (w: World) => Promise<void>;
};

/** The reason is the first word of what the row records; a detail (an ap_id) may follow it. */
const viaPipeline = async (json: Json, fetch?: ReturnType<typeof stubFetch>['fetch']): Promise<Outcome> => {
  const { stored } = await deliver(json, { fetch });
  return { state: stored!.state, error: stored!.error?.split(' ')[0] ?? null };
};

const cases: Case[] = [
  {
    id: 'N0',
    title: 'control: a signed comment from a rogue peer on a post in !spike',
    expected: { state: 'applied' },
    run: () => viaPipeline(create(note(randomUUID()))),
  },
  {
    id: 'N1',
    title: 'a non-moderator removes a post (Delete with a reason)',
    expected: { state: 'skipped', error: 'mod.moderator_required' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'delete'),
        type: 'Delete',
        actor: mallory,
        object: t1,
        summary: 'spam',
        ...addressedToCommunity(spike),
      }),
  },
  {
    id: 'N2',
    title: 'a non-author edits a post (Update embedding a Page that is not on the author’s origin)',
    expected: { state: 'skipped', error: 'object.origin_mismatch' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'update'),
        type: 'Update',
        actor: mallory,
        ...addressedToCommunity(spike),
        object: {
          id: t1,
          type: 'Page',
          attributedTo: mallory,
          name: 'hijacked',
          content: '<p>hijacked</p>',
          audience: spike,
          to: [spike, PUBLIC],
        },
      }),
  },
  {
    id: 'N3',
    title: 'a non-moderator locks a post',
    expected: { state: 'skipped', error: 'mod.moderator_required' },
    run: () => viaPipeline({ id: activityId(rogue, 'lock'), type: 'Lock', actor: mallory, object: t1, ...addressedToCommunity(spike) }),
  },
  {
    id: 'N4',
    title: 'a non-moderator features a post',
    expected: { state: 'skipped', error: 'mod.moderator_required' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'add'),
        type: 'Add',
        actor: mallory,
        object: t1,
        target: `${spike}/featured`,
        ...addressedToCommunity(spike),
      }),
  },
  {
    id: 'N5',
    title: 'a non-moderator bans a user',
    expected: { state: 'skipped', error: 'mod.moderator_required' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'block'),
        type: 'Block',
        actor: mallory,
        object: lemmyuser,
        target: spike,
        ...addressedToCommunity(spike),
      }),
  },
  {
    id: 'N6',
    title: 'a non-moderator makes itself a moderator',
    expected: { state: 'skipped', error: 'moderators.local_collection' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'add'),
        type: 'Add',
        actor: mallory,
        object: mallory,
        target: `${spike}/moderators`,
        ...addressedToCommunity(spike),
      }),
  },
  {
    id: 'N7',
    title: 'an undo of another actor’s vote',
    expected: { state: 'skipped', error: 'embedded.actor_mismatch' },
    run: () =>
      viaPipeline({
        id: activityId(rogue, 'undo'),
        type: 'Undo',
        actor: mallory,
        ...addressedToCommunity(spike),
        object: { id: activityId(rogue, 'like'), type: 'Like', actor: lemmyuser, object: t1, audience: spike },
      }),
  },
  {
    id: 'N8',
    title: 'a report on content in another server’s community',
    expected: { state: 'skipped', error: 'report.not_local' },
    run: () =>
      viaPipeline({ id: activityId(rogue, 'flag'), type: 'Flag', actor: mallory, object: t2, summary: 'not yours to judge', to: [lab] }),
  },
  {
    id: 'N9',
    title: 'a Delete claiming another actor, signed with mallory’s key',
    expected: { status: 401 },
    run: async (w) => {
      const body = JSON.stringify({
        id: activityId(rogue, 'delete'),
        type: 'Delete',
        actor: lemmyuser,
        object: t1,
        ...addressedToCommunity(spike),
      });
      const headers = await signDelivery(w.peers.mallory.keys, 'https://fed-b.test/inbox', body);
      const response = await receiveInbound(new Request('https://fed-b.test/inbox', { method: 'POST', headers, body }));
      return { status: response.status };
    },
  },
  {
    id: 'N10',
    title: 'a followed Group announces a Delete whose id is on its own origin but names another server’s author',
    expected: { state: 'skipped', error: 'activity.origin_mismatch' },
    run: () =>
      viaPipeline(
        announce({ id: activityId(rogue, 'delete'), type: 'Delete', actor: lemmyuser, object: t2, to: [PUBLIC], cc: [lab], audience: lab }),
      ),
  },
  {
    id: 'N11',
    title: 'a followed Group announces a Delete claiming an id on another origin, which does not serve it',
    expected: { state: 'skipped', error: `embedded.unverifiable` },
    run: () => {
      const inner = {
        id: activityId('https://lemmy.test', 'delete'),
        type: 'Delete',
        actor: lemmyuser,
        object: t2,
        to: [PUBLIC],
        cc: [lab],
        audience: lab,
      };
      return viaPipeline(announce(inner), stubFetch({}).fetch);
    },
  },
  {
    id: 'N12',
    title: 'a Group announces a post addressed to a community it does not own',
    expected: { state: 'skipped', error: 'mod.announce_mismatch' },
    run: () => {
      const page = {
        id: `${rogue}/post/${randomUUID()}`,
        type: 'Page',
        attributedTo: mallory,
        name: 'smuggled',
        content: '<p>smuggled</p>',
        audience: lab,
        to: [lab, PUBLIC],
      };
      return viaPipeline(
        announce({ id: activityId(rogue, 'create'), type: 'Create', actor: mallory, object: page, to: [PUBLIC], cc: [lab], audience: lab }),
      );
    },
  },
  {
    id: 'N13',
    title: 'an Announce from an actor that is not a community',
    expected: { state: 'skipped', error: 'announce.person' },
    run: () =>
      viaPipeline(announce({ id: activityId(rogue, 'delete'), type: 'Delete', actor: mallory, object: t1, to: [PUBLIC] }, mallory)),
  },
  {
    id: 'N14',
    title: 'a user banned from !spike comments',
    expected: { state: 'skipped', error: 'community.banned' },
    setup: (w) => seedBan(w.community, w.peers.mallory),
    run: () => viaPipeline(create(note(randomUUID()))),
  },
  {
    id: 'N15',
    title: 'a comment on a locked post',
    expected: { state: 'skipped', error: 'post.locked' },
    setup: async (w) => {
      await writer()
        .update(posts)
        .set({ locked: true })
        .where(sql`${posts.id} = ${w.t1.id}`);
    },
    run: () => viaPipeline(create(note(randomUUID()))),
  },
];

describe('the authorization matrix', () => {
  test('is the 16 cases of the spike: the control and N1 to N15', () => {
    expect(cases.map(({ id }) => id)).toEqual(Array.from({ length: 16 }, (_, index) => `N${index}`));
  });

  test.each(cases)('$id: $title', async (item) => {
    useCommentDouble();
    await item.setup?.(world);
    const before = await snapshot();
    const outcome = await item.run(world);
    if ('status' in item.expected) {
      expect(outcome).toEqual(item.expected);
    } else {
      expect(outcome).toEqual({ state: item.expected.state, error: 'error' in item.expected ? item.expected.error : null });
    }
    const after = await snapshot();
    if (item.expected !== undefined && 'state' in item.expected && item.expected.state === 'applied') expect(after).not.toBe(before);
    else expect(after).toBe(before);
  });
});
