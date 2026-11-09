import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts, votes } from '@peblish/core/db/tables/content';
import { backfillLimits } from '@peblish/core/remote/backfill';
import { backfills } from '@peblish/core/remote/tables';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, inboxState, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { processPending } from '../inbound/job.ts';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId } from '../inbound/test-support.ts';
import { announceOf, collection, createOf, lab, lemmy, lemmyNote, lemmyPage, lemmyuser } from '../remote-fetch/test-support.ts';
import { forgetMissingAttempts } from '../remote-fetch/missing.ts';
import { consumer } from './consumer.ts';
import { backfillDue } from './run.ts';

type Json = Record<string, unknown>;
const { publicKeyPem } = rsaKeys();
const elsewhere = 'https://elsewhere.test';
const carol = `${elsewhere}/u/carol`;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetMissingAttempts();
  world = await seedInboundWorld();
});

/** What lemmy.test and elsewhere.test serve: the community, its collections, and carol, a user of another server. */
function peers(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  const group = actorDocument('lemmy.test', 'lab', {
    kind: 'Group',
    publicKeyPem,
    extra: { featured: `${lab}/featured`, attributedTo: `${lab}/moderators`, name: 'Lemmy lab' },
  });
  return stubFetch({
    [lab]: { body: group },
    [carol]: { body: actorDocument('elsewhere.test', 'carol', { publicKeyPem }) },
    ...nodeInfoRoutes('lemmy.test', 'lemmy'),
    ...nodeInfoRoutes('elsewhere.test', 'lemmy'),
    ...routes,
  });
}
const route = (url: string, body: unknown) => ({ [url]: { body } });

type FollowAccepted = Extract<OutboxEvent, { type: 'follow.accepted' }>;
const followAccepted = (extra: Partial<FollowAccepted> = {}): FollowAccepted => ({
  type: 'follow.accepted',
  v: 1,
  followId: world.alice.id,
  apId: 'https://fed-b.test/ap/activity/follow-lab',
  followerId: world.alice.id,
  followeeId: world.peers.lab.id,
  followerLocal: true,
  followeeLocal: false,
  ...extra,
});
const queue = (event = followAccepted()) => tx((t) => consumer.handle(event, t));
const backfill = async () => (await db().select().from(backfills).where(eq(backfills.communityId, world.peers.lab.id)))[0];
const postIds = async () => (await db().select({ apId: posts.apId }).from(posts)).map((row) => row.apId).sort();
const run = (fetch: ReturnType<typeof peers>['fetch'], extra: Parameters<typeof backfillDue>[0] = {}) =>
  backfillDue({ fetch, gapMs: 0, ...extra });

/** The outbox and featured of the lab, with the posts the tests below rely on. */
const outbox = (...pages: Json[]) => route(`${lab}/outbox`, collection(`${lab}/outbox`, pages.map(createOf)));
const featured = (...pages: Json[]) => route(`${lab}/featured`, collection(`${lab}/featured`, pages));

describe('when a follow is accepted', () => {
  test('a local follower of a remote community queues its backfill, and nothing else does', async () => {
    await queue(followAccepted({ followeeLocal: true, followeeId: world.community.id }));
    await queue(followAccepted({ followerLocal: false }));
    await queue(followAccepted({ followeeId: world.peers.lemmyuser.id })); // a Person
    expect(await db().select().from(backfills)).toEqual([]);

    await queue();
    await queue();
    expect(await backfill()).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await db().select().from(backfills)).toHaveLength(1);
  });
});

describe('the backfill of a followed community', () => {
  test('stores the posts it offers and applies the earlier Dislike that found no target, once', async () => {
    const target = `${lemmy}/post/501`;
    // The Dislike lemmy.world announced before we held the post (spike RESULT, slice 3 open item c).
    const dislike = { id: activityId(lemmy, 'dislike'), type: 'Dislike', actor: lemmyuser, object: target, audience: lab };
    const early = await deliverRow(announceOf(lab, activityId(lemmy, 'announce'), dislike), (row) =>
      processRow(row, { fetch: peers().fetch }),
    );
    expect(early.stored).toEqual({ state: 'skipped', error: `target.missing ${target}` });

    // The community's outbox lists two posts, one by a user of another server; its featured one more.
    const foreign = lemmyPage(9, { id: `${elsewhere}/post/9`, attributedTo: carol, name: 'Real' });
    const forgery = { ...foreign, name: 'Forged by the community' };
    const server = peers({
      ...outbox(lemmyPage(500), lemmyPage(501), forgery),
      ...featured(lemmyPage(503)),
      ...route(`${elsewhere}/post/9`, foreign),
    });

    await queue();
    expect(await run(server.fetch)).toBe(1);

    expect(await postIds()).toEqual(
      [`${elsewhere}/post/9`, `${lemmy}/post/500`, `${lemmy}/post/501`, `${lemmy}/post/503`, world.t1.apId, world.t2.apId].sort(),
    );
    expect(await backfill()).toMatchObject({ state: 'done', posts: 4, comments: 0, note: null });
    // The community served the other server's post in its own outbox, but is not who speaks for carol: it was read from her server.
    expect(
      (
        await db()
          .select()
          .from(posts)
          .where(eq(posts.apId, `${elsewhere}/post/9`))
      )[0]?.title,
    ).toBe('Real');
    expect(server.requests.some((request) => request.url === `${elsewhere}/post/9`)).toBe(true);
    // Lemmy's pages offer no context or replies collection, so none was looked for.
    expect(server.requests.filter((request) => /context|replies/.test(request.url))).toEqual([]);

    // The Dislike that waited is back in line and the inbound job applies it.
    expect((await inboxState(early.row.id))?.state).toBe('pending');
    await processPending();
    expect(await inboxState(early.row.id)).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes).where(eq(votes.value, -1))).toHaveLength(1);

    // Following again fills nothing twice and applies nothing twice.
    await queue();
    expect(await run(server.fetch)).toBe(1);
    expect(await backfill()).toMatchObject({ state: 'done', posts: 4 });
    expect(await processPending()).toBe(0);
    expect(await db().select().from(votes)).toHaveLength(1);
    expect(await db().select().from(posts)).toHaveLength(6);
  });

  test('reads the comments a post offers in its context collection (FEP-7888), from either server', async () => {
    const mine = lemmyNote(1, `${lemmy}/post/510`);
    const hers = lemmyNote(2, `${lemmy}/post/510`, { id: `${elsewhere}/comment/2`, attributedTo: carol });
    const contextUrl = `${lemmy}/post/510/context`;
    const server = peers({
      ...outbox(lemmyPage(510, { context: contextUrl })),
      ...route(contextUrl, collection(contextUrl, [mine, hers])),
      // Her comment is embedded above, but her server is the one that speaks for her.
      ...route(`${elsewhere}/comment/2`, {
        ...hers,
        content: '<p>As carol wrote it</p>',
        source: { content: 'As carol wrote it', mediaType: 'text/markdown' },
      }),
    });
    await queue();
    await run(server.fetch);

    expect(await backfill()).toMatchObject({ state: 'done', posts: 1, comments: 2 });
    const stored = await db().select({ apId: comments.apId, bodyMd: comments.bodyMd }).from(comments);
    expect(stored.sort((a, b) => a.apId.localeCompare(b.apId))).toEqual([
      { apId: `${elsewhere}/comment/2`, bodyMd: 'As carol wrote it' },
      { apId: `${lemmy}/comment/1`, bodyMd: 'Comment 1' },
    ]);
  });

  test('refuses a document that is not the one its listing names, and a Note where it wants posts', async () => {
    // The community lists a URL on elsewhere.test; that server answers with another host's post.
    const asked = `${elsewhere}/post/12`;
    const impostor = lemmyPage(1, { id: 'https://good.test/post/1', attributedTo: 'https://good.test/u/alice' });
    const server = peers({
      [`${lab}/outbox`]: {
        body: collection(`${lab}/outbox`, [asked, createOf(lemmyNote(30, `${lemmy}/post/540`)), createOf(lemmyPage(541))]),
      },
      ...route(asked, impostor),
    });
    await queue();
    await run(server.fetch);
    expect(await postIds()).not.toContain('https://good.test/post/1');
    expect(await db().select().from(comments)).toEqual([]);
    expect(await backfill()).toMatchObject({ state: 'done', posts: 1 });
    expect(server.requests.some((request) => request.url.startsWith('https://good.test'))).toBe(false);
  });

  test('stops at its caps and says so: posts, and requests', async () => {
    const pages = [520, 521, 522, 523].map((n) => lemmyPage(n));
    const server = peers({ ...outbox(...pages) });
    await queue();
    await run(server.fetch, { limits: { ...backfillLimits, posts: 2 } });
    expect(await backfill()).toMatchObject({ state: 'done', posts: 2, note: expect.stringContaining('stopped at 2 posts') });

    // A budget of a few requests: the community's own document and its collections use it up, then it stops.
    await queue();
    await run(peers({ ...outbox(lemmyPage(530, { id: `${elsewhere}/post/530`, attributedTo: carol })) }).fetch, {
      limits: { ...backfillLimits, requests: 3 },
    });
    expect((await backfill())?.note).toContain('stopped at 3 requests');
  });

  describe('a post’s own comment collection is the post author’s, so it yields comments on that post and nothing else', () => {
    const contextUrl = `${lemmy}/post/510/context`;
    const items = () => [
      lemmyNote(2, `${lemmy}/comment/1`), // a reply to a comment that is listed after it
      lemmyNote(1, `${lemmy}/post/510`),
      lemmyPage(520), // a Page is never a comment
      lemmyNote(3, `${lemmy}/post/511`), // a reply to another post
      lemmyNote(4, `${lemmy}/comment/77`), // a reply to nothing that reaches the post
      lemmyNote(5, `${lemmy}/comment/3`), // a reply to a comment that was refused
    ];
    const serve = (extra: Record<string, { status?: number; body?: unknown }> = {}) =>
      peers({
        ...outbox(lemmyPage(510, { context: contextUrl }), lemmyPage(511)),
        ...route(contextUrl, collection(contextUrl, items())),
        ...extra,
      });
    const commentIds = async () => (await db().select({ apId: comments.apId }).from(comments)).map((row) => row.apId).sort();

    test('in thread order, whatever order it lists them in; Pages and replies elsewhere are left', async () => {
      await queue();
      await run(serve().fetch);
      expect(await commentIds()).toEqual([`${lemmy}/comment/1`, `${lemmy}/comment/2`]);
      expect(await postIds()).not.toContain(`${lemmy}/post/520`);
      expect(await backfill()).toMatchObject({ state: 'done', posts: 2, comments: 2 });
      // Run again: nothing new is stored, and the counts do not grow.
      await queue();
      await run(serve().fetch);
      expect(await backfill()).toMatchObject({ posts: 2, comments: 2 });
    });

    test('counts every comment it stores against the caps', async () => {
      const chain = [lemmyNote(1, `${lemmy}/post/510`), lemmyNote(2, `${lemmy}/comment/1`), lemmyNote(3, `${lemmy}/comment/2`)];
      const server = peers({ ...outbox(lemmyPage(510, { context: contextUrl })), ...route(contextUrl, collection(contextUrl, chain)) });
      await queue();
      await run(server.fetch, { limits: { ...backfillLimits, commentsPerPost: 2 } });
      expect(await commentIds()).toEqual([`${lemmy}/comment/1`, `${lemmy}/comment/2`]);
      expect(await backfill()).toMatchObject({ posts: 1, comments: 2 });

      await queue();
      await run(server.fetch, { limits: { ...backfillLimits, comments: 2 } });
      expect(await commentIds()).toEqual([`${lemmy}/comment/1`, `${lemmy}/comment/2`]);
    });

    test('is not read from a server that is neither the post’s nor the community’s', async () => {
      const evil = 'https://evil.test/ctx';
      const server = peers({
        ...outbox(lemmyPage(510, { context: evil })),
        ...route(evil, collection(evil, [lemmyNote(1, `${lemmy}/post/510`)])),
      });
      await queue();
      await run(server.fetch);
      expect(await db().select().from(comments)).toEqual([]);
      expect(server.requests.some((request) => request.url === evil)).toBe(false);
      expect(await backfill()).toMatchObject({ state: 'done', posts: 1, note: expect.stringContaining('another server') });
    });
  });

  test('is tried again when the outbox is down, and fails for good after the last try', async () => {
    const server = peers({ [`${lab}/outbox`]: { status: 503 } });
    let now = new Date('2026-11-09T12:00:00Z');
    const clock = () => now;
    await queue();
    for (const [attempt, wait] of backfillLimits.retryAfterMs.entries()) {
      expect(await run(server.fetch, { now: clock })).toBe(1);
      expect(await backfill()).toMatchObject({ state: 'pending', attempts: attempt + 1, note: expect.stringContaining('outbox') });
      // Not due before its wait.
      now = new Date(now.getTime() + wait - 1000);
      expect(await run(server.fetch, { now: clock })).toBe(0);
      now = new Date(now.getTime() + 2000);
    }
    expect(await run(server.fetch, { now: clock })).toBe(1);
    expect(await backfill()).toMatchObject({ state: 'failed', attempts: backfillLimits.retryAfterMs.length + 1 });
    expect(await run(server.fetch, { now: clock })).toBe(0);
  });

  test('ends quietly when the community is gone, and marks it deleted', async () => {
    await queue();
    expect(await run(stubFetch({ [lab]: { status: 410, body: { type: 'Tombstone', id: lab } } }).fetch)).toBe(1);
    expect(await backfill()).toMatchObject({ state: 'done', posts: 0, note: expect.stringContaining('gone') });
    expect((await db().select().from(actors).where(eq(actors.id, world.peers.lab.id)))[0]?.deletedAt).toBeInstanceOf(Date);
  });

  test('keeps going when the featured collection is not there, and refuses what is not in the community', async () => {
    const server = peers({
      [`${lab}/featured`]: { status: 404 },
      ...outbox(
        lemmyPage(540),
        lemmyPage(541, { audience: `${lemmy}/c/other`, to: [`${lemmy}/c/other`] }),
        lemmyPage(542, { sensitive: true }),
      ),
    });
    await queue();
    await run(server.fetch);
    expect(await backfill()).toMatchObject({ state: 'done', posts: 1, note: expect.stringContaining('featured') });
    expect(await postIds()).toContain(`${lemmy}/post/540`);
    expect(await postIds()).not.toContain(`${lemmy}/post/541`);
    expect(await postIds()).not.toContain(`${lemmy}/post/542`);
  });
});
