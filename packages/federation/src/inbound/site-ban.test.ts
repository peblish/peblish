import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { siteBans } from '@peblish/core/bans/tables';
import { db } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { modlog } from '@peblish/core/db/tables/moderation';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { deliverRow, seedInboundWorld, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, hosts, PUBLIC } from './test-support.ts';

// A Block aimed at a whole instance (a target with the path "/"): what Lemmy and PieFed send
// every instance they know when one of their admins bans a user of theirs.

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const lemmySite = 'https://lemmy.test/';
const lemmyBlock = (extra: Record<string, unknown> = {}) => ({
  id: activityId('https://lemmy.test', 'block'),
  type: 'Block',
  actor: hosts.lemmyadmin,
  object: hosts.lemmyuser,
  target: lemmySite,
  to: [PUBLIC],
  cc: [lemmySite, 'https://piefed.test/', 'https://fed-b.test/'],
  summary: 'Spam',
  removeData: false,
  ...extra,
});
const undo = (block: Record<string, unknown>, actor: string = hosts.lemmyadmin) => ({
  id: activityId('https://lemmy.test', 'undo'),
  type: 'Undo',
  actor,
  object: block,
  to: [PUBLIC],
});

const send = async (json: Record<string, unknown>) => (await deliverRow(json, (row) => processRow(row))).stored;
const applied = { state: 'applied', error: null };
const bans = () => db().select().from(siteBans);

describe('a Block of a person by their own instance', () => {
  test('Lemmy: the person is banned as a peer’s ban, and the Undo lifts it', async () => {
    const block = lemmyBlock();
    expect(await send(block)).toEqual(applied);
    expect(await bans()).toMatchObject([
      {
        actorId: world.peers.lemmyuser.id,
        source: 'remote',
        reason: 'Spam',
        expiresAt: null,
        activityApId: block.id,
        bannedBy: world.peers.lemmyadmin.id,
      },
    ]);
    const [entry] = await db().select().from(modlog);
    expect(entry).toMatchObject({
      action: 'mod.site_ban',
      communityId: null,
      authority: { kind: 'owner', actorId: world.peers.lemmyadmin.id },
      activityApId: block.id,
    });
    expect(await send(undo(block))).toEqual(applied);
    expect(await bans()).toEqual([]);
  });

  test('removeData removes what the person posted here, and the ban relays to nobody', async () => {
    expect(await send(lemmyBlock({ removeData: true }))).toEqual(applied);
    const [post] = await db().select().from(posts).where(eq(posts.id, world.t1.id));
    expect(post?.removedAt).toBeInstanceOf(Date);
    expect(await bans()).toMatchObject([{ removeContent: true }]);
  });

  test('PieFed: an end in the year 2100 is a permanent ban, and an end that has passed is skipped', async () => {
    const piefedSite = 'https://piefed.test/';
    const block = {
      id: activityId('https://piefed.test', 'block'),
      type: 'Block',
      actor: 'https://piefed.test/u/pfadmin',
      object: hosts.pfuser,
      target: piefedSite,
      audience: piefedSite,
      to: [PUBLIC],
      cc: [piefedSite],
      endTime: '2100-01-01T00:00:00+00:00',
      expires: '2100-01-01T00:00:00+00:00',
      removeData: false,
      summary: 'Spam',
    };
    await seedPeerActor(world.instances.piefed, 'Person', 'pfadmin');
    expect(await send(block)).toEqual(applied);
    expect((await bans())[0]?.expiresAt).toBeNull();
    const past = await send({
      ...block,
      id: block.id + '-past',
      expires: '2020-01-01T00:00:00+00:00',
      endTime: '2020-01-01T00:00:00+00:00',
    });
    expect(past?.error).toMatch(/^block\.expired/);
  });

  test('a ban with an end date lasts until then', async () => {
    const end = new Date(Date.now() + 7 * 86_400_000);
    expect(await send(lemmyBlock({ expires: end.toISOString() }))).toEqual(applied);
    expect((await bans())[0]?.expiresAt?.getTime()).toBe(end.getTime());
  });
});

describe('what a peer may not do', () => {
  test.each([
    ['the person is on another instance', (block: Record<string, unknown>) => ({ ...block, object: hosts.pfuser }), 'ban.origin_mismatch'],
    [
      'the target is another instance',
      (block: Record<string, unknown>) => ({ ...block, target: 'https://piefed.test/' }),
      'ban.origin_mismatch',
    ],
    ['the person is one of ours', (block: Record<string, unknown>) => ({ ...block, object: world.alice.apId }), 'ban.origin_mismatch'],
  ])('%s: ban.origin_mismatch and nothing changes', async (_name, shape, reason) => {
    const stored = await send(shape(lemmyBlock()));
    expect(stored).toMatchObject({ state: 'skipped' });
    expect(stored?.error).toMatch(new RegExp(`^${reason}`));
    expect(await bans()).toEqual([]);
  });

  test('a ban a community announced is refused: a community does not speak for the site', async () => {
    const announce = {
      id: activityId('https://lemmy.test', 'announce'),
      type: 'Announce',
      actor: hosts.lab,
      object: lemmyBlock(),
      to: [PUBLIC],
      cc: [`${hosts.lab}/followers`],
    };
    const stored = await send(announce);
    expect(stored?.error).toMatch(/^mod\.announce_mismatch/);
    expect(await bans()).toEqual([]);
  });

  test('a second Block never replaces a held ban, and an Undo does not lift a ban of ours', async () => {
    expect(await send(lemmyBlock())).toEqual(applied);
    const again = await send(lemmyBlock({ summary: 'Changed my mind' }));
    expect(again?.error).toMatch(/^target\.site_banned/);
    expect((await bans())[0]?.reason).toBe('Spam');

    await writer().update(siteBans).set({ source: 'local' }).where(eq(siteBans.actorId, world.peers.lemmyuser.id));
    const lifted = await send(undo(lemmyBlock()));
    expect(lifted?.error).toMatch(/^target\.not_site_banned/);
    expect(await bans()).toHaveLength(1);
  });

  test('an Undo of a ban nobody set is skipped', async () => {
    expect((await send(undo(lemmyBlock())))?.error).toMatch(/^target\.not_site_banned/);
  });

  test('another actor’s Undo does not undo the Block', async () => {
    const block = lemmyBlock();
    expect(await send(block)).toEqual(applied);
    const stored = await send(undo(block, hosts.lemmyuser));
    expect(stored?.state).toBe('skipped');
    expect(await bans()).toHaveLength(1);
  });
});
