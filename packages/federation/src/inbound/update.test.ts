import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedFollow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { seedActor } from '@peblish/core/testing/seed';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

// An Update is checked against the object we hold: the community its Page names, the post and
// parent its Note replies to, and the sensitive-content rule, before anything is authorized or
// relayed.

const lemmy = 'https://lemmy.test';
const { spike, lab, lemmyuser, t1 } = hosts;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));
const page = (community: string, extra: Record<string, unknown> = {}) => ({
  id: t1,
  type: 'Page',
  attributedTo: lemmyuser,
  name: 'Edited title',
  content: '<p>edited</p>',
  source: { content: 'edited', mediaType: 'text/markdown' },
  published: '2026-11-09T10:00:00Z',
  audience: community,
  to: [community, PUBLIC],
  ...extra,
});
const updatePage = (community: string, extra: Record<string, unknown> = {}, announceBy?: string) => {
  const update = {
    id: activityId(lemmy, 'update'),
    type: 'Update',
    actor: lemmyuser,
    object: page(community, extra),
    ...addressedToCommunity(community),
  };
  return announceBy
    ? {
        id: activityId(lemmy, 'announce'),
        type: 'Announce',
        actor: announceBy,
        to: [PUBLIC],
        cc: [`${announceBy}/followers`],
        object: update,
      }
    : update;
};
const title = async () => (await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.title;
const originalTitle = () => `Post ${world.t1.id}`;

/** A second community here, with a follower on another server, so a wrongly relayed Update would show as a delivery. */
async function seedOtherCommunity() {
  const other = await seedActor(world.instances.local, 'Group', 'other', {
    inboxUrl: 'https://fed-b.test/ap/c.other/inbox',
    sharedInboxUrl: 'https://fed-b.test/inbox',
    followersUrl: 'https://fed-b.test/ap/c.other/followers',
  });
  await seedFollow(world.peers.remoteFollower, other, 'https://mastodon.test/activities/follow-other');
  return other;
}

describe('an Update of a post we hold', () => {
  test('is relayed in the community the post is in', async () => {
    const edited = await deliver(updatePage(spike));
    expect(edited.stored).toEqual({ state: 'applied', error: null });
    expect(await title()).toBe('Edited title');
    expect((await db().select().from(deliveries)).map((row) => row.inboxUrl)).toEqual(['https://mastodon.test/inbox']);
  });

  test('that names another community stores nothing and relays nothing, however the author is treated there', async () => {
    const other = await seedOtherCommunity();
    const claimed = await deliver(updatePage(other.apId));
    expect(claimed.stored?.error).toMatch(/^community\.mismatch /);
    expect(await title()).toBe(originalTitle());
    expect(await db().select().from(deliveries)).toEqual([]);
  });

  test('inside the Announce of a community the post is not in is refused, as is a Page naming that community', async () => {
    const announcedAsHeld = await deliver(updatePage(spike, {}, lab));
    expect(announcedAsHeld.stored).toEqual({ state: 'skipped', error: 'mod.announce_mismatch' });
    const announcedAsClaimed = await deliver(updatePage(lab, {}, lab));
    expect(announcedAsClaimed.stored?.error).toMatch(/^community\.mismatch /);
    expect(await title()).toBe(originalTitle());
  });

  test.each([{ sensitive: true }, { nsfl: true }])(
    'that makes the post %o, which a Create would be refused for, removes our copy as its author deleting it would (item 6)',
    async (flags) => {
      const edited = await deliver(updatePage(spike, flags));
      expect(edited.stored).toEqual({ state: 'applied', error: null });
      const [held] = await db().select().from(posts).where(eq(posts.apId, t1));
      // Not stored as the sensitive edit: the copy we held is deleted, and nothing is relayed.
      expect([held?.title, held?.sensitive, held?.deletedAt !== null]).toEqual([originalTitle(), false, true]);
      expect(await db().select().from(deliveries)).toEqual([]);
      // A second such Update finds the copy gone and is refused as before.
      const again = await deliver({ ...updatePage(spike, flags), id: activityId(lemmy, 'update-again') });
      expect(again.stored?.error).toMatch(/^content\.nsfw_rejected/);
    },
  );
});

describe('an Update of a comment we hold', () => {
  const note = (inReplyTo: string, apId: string) => ({
    id: apId,
    type: 'Note',
    attributedTo: lemmyuser,
    inReplyTo,
    content: '<p>edited comment</p>',
    source: { content: 'edited comment', mediaType: 'text/markdown' },
    published: '2026-11-09T10:00:00Z',
    audience: spike,
    to: [PUBLIC],
    cc: [spike],
  });
  const updateNote = (inReplyTo: string, apId: string) => ({
    id: activityId(lemmy, 'update'),
    type: 'Update',
    actor: lemmyuser,
    object: note(inReplyTo, apId),
    ...addressedToCommunity(spike),
  });

  test('must reply to what the stored comment replies to', async () => {
    const comment = await seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, {
      apId: `${lemmy}/comment/1`,
      local: false,
    });
    const body = async () => (await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.bodyMd;
    const moved = await deliver(updateNote(world.t2.apId, comment.apId));
    expect(moved.stored).toEqual({ state: 'skipped', error: `parent.mismatch ${world.t2.apId}` });
    const unknown = await deliver(updateNote(`${lemmy}/post/none`, comment.apId));
    expect(unknown.stored?.error).toMatch(/^parent\.mismatch /);
    expect(await body()).toBe('A comment');
    expect(await db().select().from(deliveries)).toEqual([]);

    const edited = await deliver(updateNote(t1, comment.apId));
    expect(edited.stored).toEqual({ state: 'applied', error: null });
    expect(await body()).toBe('edited comment');
  });
});
