import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { truncateAll } from '@peblish/core/testing/db';
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
