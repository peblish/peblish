import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { reports } from '@peblish/core/db/tables/moderation';
import { writer } from '@peblish/core/db/write';
import { communityBans } from '@peblish/core/moderation/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { deliverRow, seedLabWorld } from '@peblish/core/testing/seed-fed-b';
import { activityId } from './test-support.ts';
import { readFixture } from '../test/manifest.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';

// A Flag from a peer becomes a report (category other, the reason as its details) for the
// moderators of the community it names, or for the admins when it is about one of our people.

type Lab = Awaited<ReturnType<typeof seedLabWorld>>;
let lab: Lab;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  lab = await seedLabWorld();
});

const lemmyFlag = () => ({ ...(readFixture('wire/lemmy-0.19.21/inbound/inbound-0045-flag.json') as Record<string, unknown>) });
const pieFedFlag = () => ({ ...(readFixture('wire/piefed-1.8.11/inbound/inbound-0062-flag.json') as Record<string, unknown>) });
const send = async (flag: Record<string, unknown>, fresh = true) => {
  const body = fresh ? { ...flag, id: activityId('https://lemmy.lab.test', 'flag') } : flag;
  return (await deliverRow(body, (row) => processRow(row))).stored;
};
const rows = () => db().select().from(reports);
const community = 'https://feddit.lab.test/ap/c.spike';

describe('a Flag from Lemmy or PieFed about a post here', () => {
  test.each([
    ['Lemmy', lemmyFlag, 'https://lemmy.lab.test/u/lemmyuser', 'https://feddit.lab.test/ap/post/21'],
    ['PieFed', pieFedFlag, 'https://piefed.lab.test/u/pfuser', 'https://feddit.lab.test/ap/post/25'],
  ])('%s: one open report in the community, filed as other with the reason, the Flag kept', async (_peer, flag, reporter, target) => {
    const document = flag();
    expect(await send(document, false)).toMatchObject({ state: 'applied', error: null });
    const [row] = await rows();
    const [post] = await db().select({ id: posts.id }).from(posts).where(eq(posts.apId, target));
    expect(row).toMatchObject({
      local: false,
      category: 'other',
      audience: 'moderators',
      status: 'open',
      reason: 'S14 report 1108022723',
      apId: document.id,
      targetPostId: post?.id,
      communityId: lab.id(community),
      reporterId: lab.id(reporter),
    });
    expect(row?.raw).toMatchObject({ type: 'Flag', id: document.id });
  });

  test.each([
    ['removed', async (id: string) => writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, id)), 'target.removed'],
    ['deleted', async (id: string) => writer().update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, id)), 'target.deleted'],
  ])('a %s post takes no report', async (_state, change, reason) => {
    const [post] = await db().select({ id: posts.id }).from(posts).where(eq(posts.apId, 'https://feddit.lab.test/ap/post/21'));
    await change(post!.id);
    expect(await send(lemmyFlag())).toMatchObject({ state: 'skipped', error: expect.stringContaining(reason) });
    expect(await rows()).toEqual([]);
  });

  test('a reporter banned from the community, and a second Flag from the same reporter, are skipped', async () => {
    expect(await send(lemmyFlag())).toMatchObject({ state: 'applied' });
    expect(await send(lemmyFlag())).toMatchObject({ state: 'skipped', error: expect.stringContaining('report.duplicate') });
    await writer().delete(reports);
    await writer()
      .insert(communityBans)
      .values({ communityId: lab.id(community), actorId: lab.id('https://lemmy.lab.test/u/lemmyuser') });
    expect(await send(lemmyFlag())).toMatchObject({ state: 'skipped', error: expect.stringContaining('community.banned') });
    expect(await rows()).toEqual([]);
  });

  test('content that is not ours is skipped', async () => {
    expect(await send({ ...lemmyFlag(), object: 'https://lemmy.lab.test/post/15' })).toMatchObject({
      state: 'skipped',
      error: expect.stringContaining('report.not_local'),
    });
    expect(await rows()).toEqual([]);
  });
});

describe('a Flag about one of our people', () => {
  test('is a report for the admins alone, with no community', async () => {
    const person = 'https://feddit.lab.test/ap/u.m1108022723';
    expect(await send({ ...lemmyFlag(), object: [person, 'https://feddit.lab.test/ap/post/21'] })).toMatchObject({ state: 'applied' });
    const [row] = await rows();
    expect(row).toMatchObject({
      audience: 'admins',
      category: 'other',
      communityId: null,
      targetActorId: lab.id(person),
      targetPostId: null,
      reporterId: lab.id('https://lemmy.lab.test/u/lemmyuser'),
    });
  });

  test('a remote person is not ours to judge', async () => {
    expect(await send({ ...lemmyFlag(), object: 'https://lemmy.lab.test/u/lemmyadmin' })).toMatchObject({
      state: 'skipped',
      error: expect.stringContaining('report.not_local'),
    });
  });
});
