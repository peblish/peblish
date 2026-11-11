import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { storeObject } from '../remote-fetch/object.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, hosts, PUBLIC } from './test-support.ts';

// F2 (B07): what is not addressed to Public is never stored, converted or relayed. The shapes
// are Mastodon's (a private status reaches a community it mentions, and so does a direct one)
// and Lemmy's (a Page in a Create, an Update, a community's Announce of a bare Page). Before the
// fix the Mastodon statuses became public posts here, announced to the spike's followers.

const { spike, lab, lemmyuser, t1 } = hosts;
const context = ['https://www.w3.org/ns/activitystreams', { sensitive: 'as:sensitive' }];

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const deliver = (json: Record<string, unknown>, routes: Parameters<typeof stubFetch>[0] = {}) =>
  deliverRow(json, (row) => processRow(row, { fetch: stubFetch(routes).fetch }));
const postAt = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0];
const nothingRelayed = async () => expect(await db().select().from(deliveries)).toEqual([]);

/** A Mastodon status by the spike's follower on mastodon.test, as its Create carries it, with the addressing given. */
function status(n: number, addressing: { to: string[]; cc: string[] }, extra: Record<string, unknown> = {}) {
  const author = world.peers.remoteFollower.apId;
  const id = `https://mastodon.test/users/follower/statuses/${n}`;
  const object = {
    id,
    type: 'Note',
    summary: null,
    inReplyTo: null,
    published: '2026-11-10T09:00:00Z',
    url: `https://mastodon.test/@follower/${n}`,
    attributedTo: author,
    ...addressing,
    sensitive: false,
    content: '<p><span class="h-card"><a href="https://fed-b.test/ap/c.spike" class="u-url mention">@spike</a></span> only for you</p>',
    tag: [{ type: 'Mention', href: spike, name: '@spike@fed-b.test' }],
    attachment: [],
    ...extra,
  };
  return { '@context': context, id: `${id}/activity`, type: 'Create', actor: author, published: object.published, ...addressing, object };
}
const followers = 'https://mastodon.test/u/follower/followers';

describe('a post or comment that is not addressed to Public', () => {
  test('a followers-only status mentioning a community here is refused, not made a post and announced', async () => {
    const create = status(1, { to: [followers], cc: [spike] });
    expect((await deliver(create)).stored).toEqual({ state: 'skipped', error: `content.not_public ${create.object.id}` });
    expect(await postAt(create.object.id)).toBeUndefined();
    await nothingRelayed();
  });

  test('a direct status to a community here is refused the same way', async () => {
    const create = status(2, { to: [spike, 'https://fed-b.test/ap/u.alice'], cc: [] });
    expect((await deliver(create)).stored).toEqual({ state: 'skipped', error: `content.not_public ${create.object.id}` });
    expect(await postAt(create.object.id)).toBeUndefined();
    await nothingRelayed();
  });

  test('a followers-only reply to a post here is refused, not stored as a comment', async () => {
    const create = status(3, { to: [followers], cc: [spike, lemmyuser] }, { inReplyTo: t1 });
    expect((await deliver(create)).stored).toEqual({ state: 'skipped', error: `content.not_public ${create.object.id}` });
    expect(await db().select().from(comments).where(eq(comments.apId, create.object.id))).toEqual([]);
    await nothingRelayed();
  });

  test('a public Page in a Create that is not addressed to Public is refused', async () => {
    const id = 'https://lemmy.test/post/40';
    const object = { id, type: 'Page', attributedTo: lemmyuser, name: 'Hidden', content: '<p>x</p>', audience: spike, to: [spike, PUBLIC] };
    const create = {
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: lemmyuser,
      object,
      to: [spike],
      audience: spike,
    };
    expect((await deliver(create)).stored).toEqual({ state: 'skipped', error: `content.not_public ${id}` });
    expect(await postAt(id)).toBeUndefined();
  });

  test('an Update that makes a post followers-only is refused, and the post keeps what it said', async () => {
    const before = await postAt(t1);
    const object = {
      id: t1,
      type: 'Page',
      attributedTo: lemmyuser,
      name: 'Now private',
      content: '<p>x</p>',
      audience: spike,
      to: [spike],
    };
    const update = {
      id: activityId('https://lemmy.test', 'update'),
      type: 'Update',
      actor: lemmyuser,
      object,
      to: [spike],
      audience: spike,
    };
    expect((await deliver(update)).stored).toEqual({ state: 'skipped', error: `content.not_public ${t1}` });
    expect((await postAt(t1))?.title).toBe(before?.title);
  });

  test('a bare Page a followed community announces is refused when the Page is not addressed to Public', async () => {
    const id = 'https://lemmy.test/post/41';
    const announce = {
      id: activityId('https://lemmy.test', 'announce'),
      type: 'Announce',
      actor: lab,
      to: [PUBLIC],
      cc: [`${lab}/followers`],
      object: { id, type: 'Page', attributedTo: lemmyuser, name: 'Members only', content: '<p>x</p>', audience: lab, to: [lab] },
    };
    expect((await deliver(announce)).stored).toEqual({ state: 'skipped', error: `content.not_public ${id}` });
    expect(await postAt(id)).toBeUndefined();
  });

  test('an announced Create read again from its origin is refused when the origin’s copy is not public', async () => {
    // The community's embedded copy says Public; piefed.test, which the Create is from, serves it followers-only.
    const id = 'https://piefed.test/post/42';
    const pageOf = (to: string[]) => ({ id, type: 'Page', attributedTo: hosts.pfuser, name: 'P', content: '<p>x</p>', audience: lab, to });
    const createId = 'https://piefed.test/activities/create/42';
    const create = (to: string[]) => ({
      id: createId,
      type: 'Create',
      actor: hosts.pfuser,
      object: pageOf(to),
      to,
      cc: [lab],
      audience: lab,
    });
    const announce = {
      id: activityId('https://lemmy.test', 'announce'),
      type: 'Announce',
      actor: lab,
      to: [PUBLIC],
      cc: [`${lab}/followers`],
      object: create([lab, PUBLIC]),
    };
    const { stored } = await deliver(announce, { [createId]: { body: create([lab, 'https://piefed.test/u/pfuser/followers']) } });
    expect(stored).toEqual({ state: 'skipped', error: `content.not_public ${id}` });
    expect(await postAt(id)).toBeUndefined();
  });

  test('an object fetched by id (backfill, a missing object, a search) is refused when it is not public', async () => {
    const id = 'https://lemmy.test/post/43';
    const json = { id, type: 'Page', attributedTo: lemmyuser, name: 'Fetched', content: '<p>x</p>', audience: lab, to: [lab] };
    const outcome = await storeObject(
      json,
      { community: world.peers.lab, announceApId: `${lab}/outbox` },
      { fetch: stubFetch({}).fetch, depth: 0 },
    );
    expect(outcome).toEqual({ status: 'refused', apId: id, reason: 'content.not_public' });
    expect(await postAt(id)).toBeUndefined();
  });

  test('an unlisted status (Public in cc) is still a post: the rule is Public anywhere in to or cc', async () => {
    const create = status(5, { to: [followers], cc: [PUBLIC, spike] });
    expect((await deliver(create)).stored).toEqual({ state: 'applied', error: null });
    expect(await postAt(create.object.id)).toBeDefined();
  });
});
