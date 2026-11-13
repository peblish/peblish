import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { outbox } from '@peblish/core/db/tables/outbox';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { owedAfterDrain, startDrain } from '@peblish/core/testing/edge-drain';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, hosts, PUBLIC } from './test-support.ts';

// A withdrawal (an Update that a Create would be refused for: followers-only, sensitive, NSFL)
// removes our copy only when it is not older than the revision we hold, by the edit path's own
// rule (core posts/remote.ts olderThanHeld). Each case first applies a newer public revision,
// then an older withdrawal from the genuine author arrives late: it must change nothing and write
// no ledger row. A withdrawal newer than what we hold still removes our copy.

const lemmy = 'https://lemmy.test';
const { spike, lab, lemmyuser, t1, t2 } = hosts;
const followers = `${lemmyuser}/followers`;
const older = '2026-11-12T11:00:00Z';
const held = '2026-11-12T12:00:00Z';
const newer = '2026-11-12T13:00:00Z';

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));
const ledgerRows = async () => (await db().select().from(deletionLedger)).length;

type Form = 'followers-only' | 'sensitive' | 'nsfl';
const addressing = (community: string, form: Form | 'public') => (form === 'followers-only' ? [community, followers] : [community, PUBLIC]);
const flags = (form: Form | 'public') =>
  form === 'sensitive' ? { sensitive: true } : form === 'nsfl' ? { sensitive: true, nsfl: true } : {};

/** An Update by lemmyuser of `object`, sent to `community`, inside the community's Announce when `announced`. */
function update(object: Record<string, unknown>, community: string, to: string[], announced: boolean) {
  const inner = { id: activityId(lemmy, 'update'), type: 'Update', actor: lemmyuser, object: { ...object, to }, to, audience: community };
  if (!announced) return inner;
  return {
    id: activityId(lemmy, 'announce'),
    type: 'Announce',
    actor: community,
    to: [PUBLIC],
    cc: [`${community}/followers`],
    object: inner,
  };
}

const page = (apId: string, community: string, title: string, updated: string, form: Form | 'public') => ({
  id: apId,
  type: 'Page',
  attributedTo: lemmyuser,
  name: title,
  content: `<p>${title}</p>`,
  published: '2026-11-09T10:00:00Z',
  updated,
  audience: community,
  ...flags(form),
});

describe.each([
  { how: 'direct', apId: t1, community: spike, announced: false },
  { how: 'announced', apId: t2, community: lab, announced: true },
])('a $how Update of a post we hold', ({ apId, community, announced }) => {
  const post = async () => (await db().select().from(posts).where(eq(posts.apId, apId)))[0];
  const send = (title: string, updated: string, form: Form | 'public') =>
    deliver(update(page(apId, community, title, updated, form), community, addressing(community, form), announced));

  test.each(['followers-only', 'sensitive', 'nsfl'] as const)(
    'that withdraws it %s is ignored when older than the revision we hold, and removes it when newer',
    async (form) => {
      expect((await send('Newer public revision', held, 'public')).stored?.state).toBe('applied');
      expect((await post())?.title).toBe('Newer public revision');

      expect((await send('Old private revision', older, form)).stored?.state).toBe('applied');
      expect(await post()).toMatchObject({ title: 'Newer public revision', deletedAt: null });
      expect(await ledgerRows()).toBe(0);

      expect((await send('Newer private revision', newer, form)).stored?.state).toBe('applied');
      expect((await post())?.deletedAt).not.toBeNull();
      expect(await ledgerRows()).toBe(1);
    },
  );
});

describe.each([
  { how: 'direct', on: 't1', community: spike, announced: false },
  { how: 'announced', on: 't2', community: lab, announced: true },
] as const)('a $how Update of a comment we hold', ({ on, community, announced }) => {
  test('that makes it followers-only is ignored when older than the revision we hold, and removes it when newer', async () => {
    const parent = world[on];
    const apId = `${lemmy}/comment/90`;
    const seeded = await seedComment(world.instances.lemmy, parent, world.peers.lemmyuser, { apId, local: false });
    const comment = async () => (await db().select().from(comments).where(eq(comments.id, seeded.id)))[0];
    const note = (text: string, updated: string) => ({
      id: apId,
      type: 'Note',
      attributedTo: lemmyuser,
      inReplyTo: parent.apId,
      content: `<p>${text}</p>`,
      published: '2026-11-09T10:00:00Z',
      updated,
      audience: community,
    });
    const send = (text: string, updated: string, form: 'followers-only' | 'public') =>
      deliver(update(note(text, updated), community, addressing(community, form), announced));

    expect((await send('newer public revision', held, 'public')).stored?.state).toBe('applied');
    expect((await comment())?.contentHtml).toContain('newer public revision');

    expect((await send('old private revision', older, 'followers-only')).stored?.state).toBe('applied');
    const kept = await comment();
    expect(kept?.deletedAt).toBeNull();
    expect(kept?.contentHtml).toContain('newer public revision');
    expect(await ledgerRows()).toBe(0);

    expect((await send('newer private revision', newer, 'followers-only')).stored?.state).toBe('applied');
    expect((await comment())?.deletedAt).not.toBeNull();
    expect(await ledgerRows()).toBe(1);
  });
});

test('a withdrawal without `updated`, or with the time we hold, removes our copy, as such an edit would apply', async () => {
  const post = async () => (await db().select().from(posts).where(eq(posts.apId, t1)))[0];
  const send = (object: Record<string, unknown>, to: string[]) => deliver(update(object, spike, to, false));
  expect((await send(page(t1, spike, 'Held', held, 'public'), [spike, PUBLIC])).stored?.state).toBe('applied');
  expect((await send(page(t1, spike, 'Same time', held, 'followers-only'), [spike, followers])).stored?.state).toBe('applied');
  expect((await post())?.deletedAt).not.toBeNull();

  await truncateAll();
  world = await seedInboundWorld();
  expect((await send(page(t1, spike, 'Held', held, 'public'), [spike, PUBLIC])).stored?.state).toBe('applied');
  const { updated: _updated, ...undated } = page(t1, spike, 'No time', held, 'followers-only');
  expect((await send(undated, [spike, followers])).stored?.state).toBe('applied');
  expect((await post())?.deletedAt).not.toBeNull();
});

test('a stale withdrawal leaves no content event, no edge purge debt and no relay delivery', async () => {
  const comment = await seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/92`, local: false });
  const note = (text: string, updated: string) => ({
    id: comment.apId,
    type: 'Note',
    attributedTo: lemmyuser,
    inReplyTo: t1,
    content: `<p>${text}</p>`,
    updated,
    audience: spike,
  });
  const followersOnly = [spike, followers];
  expect((await deliver(update(page(t1, spike, 'Held', held, 'public'), spike, [spike, PUBLIC], false))).stored?.state).toBe('applied');
  expect((await deliver(update(note('held', held), spike, [spike, PUBLIC], false))).stored?.state).toBe('applied');
  await startDrain();
  const [{ last } = { last: 0 }] = await db()
    .select({ last: sql<number>`coalesce(max(${outbox.id}), 0)::int` })
    .from(outbox);
  const relayed = (await db().select().from(deliveries)).length;

  expect((await deliver(update(page(t1, spike, 'Old', older, 'followers-only'), spike, followersOnly, false))).stored?.state).toBe(
    'applied',
  );
  expect((await deliver(update(note('old', older), spike, followersOnly, false))).stored?.state).toBe('applied');

  const events = await db()
    .select({ type: outbox.type })
    .from(outbox)
    .where(sql`${outbox.id} > ${last}`);
  expect(events.filter(({ type }) => type.startsWith('post.') || type.startsWith('comment.'))).toEqual([]);
  expect(await owedAfterDrain()).toEqual([]);
  expect((await db().select().from(deliveries)).length).toBe(relayed);
  expect(await ledgerRows()).toBe(0);
});

describe('an ordinary edit keeps the revision monotonic (round 5)', () => {
  const comment = () => seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/93`, local: false });
  const note = (apId: string, text: string, updated: string | null) => ({
    id: apId,
    type: 'Note',
    attributedTo: lemmyuser,
    inReplyTo: t1,
    content: `<p>${text}</p>`,
    ...(updated && { updated }),
    audience: spike,
  });
  const sendNote = (apId: string, text: string, updated: string | null, form: 'public' | 'followers-only' = 'public') =>
    deliver(update(note(apId, text, updated), spike, addressing(spike, form), false));
  const commentRow = async (id: string) => (await db().select().from(comments).where(eq(comments.id, id)))[0];
  const postRow = async () => (await db().select().from(posts).where(eq(posts.apId, t1)))[0];
  const sendPage = (title: string, updated: string | null, form: Form | 'public' = 'public') => {
    const { updated: _updated, ...undated } = page(t1, spike, title, updated ?? held, form);
    return deliver(update(updated ? { ...undated, updated } : undated, spike, addressing(spike, form), false));
  };
  const commentEvents = async () =>
    (await db().select({ type: outbox.type }).from(outbox)).filter(({ type }) => type === 'comment.updated').length;

  test('a stale public comment edit is not applied, so an older withdrawal after it is still stale (sequence a)', async () => {
    const { id, apId } = await comment();
    expect((await sendNote(apId, 'revision 12:00', '2026-11-12T12:00:00Z')).stored?.state).toBe('applied');
    const events = await commentEvents();
    expect((await sendNote(apId, 'revision 10:00', '2026-11-12T10:00:00Z')).stored?.state).toBe('applied');
    expect(await commentRow(id)).toMatchObject({ editedAt: new Date('2026-11-12T12:00:00Z') });
    expect((await commentRow(id))?.contentHtml).toContain('revision 12:00');
    expect(await commentEvents()).toBe(events);
    expect((await sendNote(apId, 'private 11:00', '2026-11-12T11:00:00Z', 'followers-only')).stored?.state).toBe('applied');
    const kept = await commentRow(id);
    expect(kept?.deletedAt).toBeNull();
    expect(kept?.contentHtml).toContain('revision 12:00');
    expect(await ledgerRows()).toBe(0);
  });

  test('a newer comment Update that changes only its time stores the time, so a withdrawal between the two is stale (sequence b)', async () => {
    const { id, apId } = await comment();
    expect((await sendNote(apId, 'revision 12:00', '2026-11-12T12:00:00Z')).stored?.state).toBe('applied');
    expect((await sendNote(apId, 'revision 12:00', '2026-11-12T13:00:00Z')).stored?.state).toBe('applied');
    expect((await commentRow(id))?.editedAt).toEqual(new Date('2026-11-12T13:00:00Z'));
    expect((await sendNote(apId, 'private 12:30', '2026-11-12T12:30:00Z', 'followers-only')).stored?.state).toBe('applied');
    const kept = await commentRow(id);
    expect(kept?.deletedAt).toBeNull();
    expect(kept?.contentHtml).toContain('revision 12:00');
    expect(await ledgerRows()).toBe(0);
  });

  test('the post equivalents: a stale edit is not applied, and a newer time-only Update is stored', async () => {
    expect((await sendPage('Revision 12:00', '2026-11-12T12:00:00Z')).stored?.state).toBe('applied');
    expect((await sendPage('Revision 10:00', '2026-11-12T10:00:00Z')).stored?.state).toBe('applied');
    expect(await postRow()).toMatchObject({ title: 'Revision 12:00', editedAt: new Date('2026-11-12T12:00:00Z') });
    expect((await sendPage('Revision 12:00', '2026-11-12T13:00:00Z')).stored?.state).toBe('applied');
    expect((await postRow())?.editedAt).toEqual(new Date('2026-11-12T13:00:00Z'));
    expect((await sendPage('Private 12:30', '2026-11-12T12:30:00Z', 'followers-only')).stored?.state).toBe('applied');
    expect(await postRow()).toMatchObject({ title: 'Revision 12:00', deletedAt: null });
  });

  test('an undated edit never moves the stored time back, for a comment and a post', async () => {
    const future = new Date('2030-01-01T00:00:00Z');
    const { id, apId } = await comment();
    expect((await sendNote(apId, 'future-dated', future.toISOString())).stored?.state).toBe('applied');
    expect((await sendNote(apId, 'undated change', null)).stored?.state).toBe('applied');
    expect(await commentRow(id)).toMatchObject({ editedAt: future });
    expect((await commentRow(id))?.contentHtml).toContain('undated change');

    expect((await sendPage('Future-dated', future.toISOString())).stored?.state).toBe('applied');
    expect((await sendPage('Undated change', null)).stored?.state).toBe('applied');
    expect(await postRow()).toMatchObject({ title: 'Undated change', editedAt: future });
  });
});
