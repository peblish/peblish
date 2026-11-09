import { killSwitches, siteSettings as contract, type SiteSettingKey } from '@peblish/schema/site-settings';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { ensureLocalInstance, ensureSettingRows } from '../db/bootstrap.ts';
import { writer } from '../db/write.ts';
import { imageSource } from '../media/image-src.ts';
import { truncateAll } from '../testing/db.ts';
import { seedInvite } from '../testing/seed-a.ts';
import { admin, gate, someoneWaitsOnALock } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { localUser } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { readSetting } from './read.ts';
import { updateSettingsAs } from './write.ts';

// M28: every kill switch is flipped through the real mutation, seen through the reader the
// feature uses, and flipped back. The inbox and delivery switches have their readers in
// federation (receive.ts, deliverDue), where their own tests and the e2e cases watch them.

beforeEach(truncateAll);

async function setup() {
  const world = await seedPostWorld();
  await ensureLocalInstance(writer(), 'https://feddit.test');
  const system = await systemPrincipal(db(), 'registration');
  const invite = await seedInvite(world.people.admin.id, { maxUses: 100 });
  const author = localUser(world.people.author.id);
  const subjects = {
    register: { inviteCode: invite.code, name: 'newcomer', email: 'newcomer@feddit.test', age: 30 },
    post: { communityId: world.communities.open.id },
    comment: { postId: world.posts.local.normal, parentId: null },
  };
  const flip = async (key: SiteSettingKey, value: boolean) => {
    const result = await updateSettingsAs(admin(world.people.admin.id), { [key]: value });
    if (!result.ok) throw new Error(result.reason);
  };
  const outcome = async (decision: ReturnType<typeof authorize>) => {
    const settled = await decision;
    return settled.ok ? 'allow' : settled.reason;
  };
  return { world, system, author, subjects, flip, outcome };
}

describe('each kill switch', () => {
  test('registration: account.register denies site.disabled while off, then allows again', async () => {
    const { system, subjects, flip, outcome } = await setup();
    const attempt = () => outcome(authorize('account.register', system, subjects.register));
    expect(await attempt()).toBe('allow');
    await flip('registration.enabled', false);
    expect(await attempt()).toBe('site.disabled');
    await flip('registration.enabled', true);
    expect(await attempt()).toBe('allow');
  });

  test('uploads: media.upload denies site.disabled until switched on, then off again', async () => {
    const { author, flip, outcome } = await setup();
    const attempt = () => outcome(authorize('media.upload', author, {}));
    expect(contract['uploads.enabled'].default).toBe(false);
    expect(await attempt()).toBe('site.disabled');
    await flip('uploads.enabled', true);
    expect(await attempt()).toBe('allow');
    await flip('uploads.enabled', false);
    expect(await attempt()).toBe('site.disabled');
  });

  test('remote media: media.thumbnail denies site.disabled and imageSource drops remote images while off', async () => {
    const { author, flip, outcome } = await setup();
    const preview = () => outcome(authorize('media.thumbnail', author, {}));
    const image = async () =>
      imageSource('https://lemmy.test/pictrs/image/1.png', {
        origin: 'https://feddit.test',
        remoteMedia: await readSetting('remote_media.enabled'),
        proxy: (url) => `/media/proxy/sig/${encodeURIComponent(url)}`,
      });
    expect(await preview()).toBe('allow');
    expect(await image()).toMatch(/^\/media\/proxy\//);
    await flip('remote_media.enabled', false);
    expect(await preview()).toBe('site.disabled');
    expect(await image()).toBeNull();
    await flip('remote_media.enabled', true);
    expect(await preview()).toBe('allow');
    expect(await image()).toMatch(/^\/media\/proxy\//);
  });

  test('posting: post.create and comment.create deny site.disabled for local people only', async () => {
    const { world, author, subjects, flip, outcome } = await setup();
    const remote = { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null } as const;
    const attempts = () =>
      Promise.all([
        outcome(authorize('post.create', author, subjects.post)),
        outcome(authorize('comment.create', author, subjects.comment)),
        outcome(authorize('post.create', remote, { communityId: world.communities.remote.id })),
      ]);
    expect(await attempts()).toEqual(['allow', 'allow', 'allow']);
    await flip('posting.enabled', false);
    expect(await attempts()).toEqual(['site.disabled', 'site.disabled', 'allow']);
    await flip('posting.enabled', true);
    expect(await attempts()).toEqual(['allow', 'allow', 'allow']);
  });

  test('inbox and delivery: the readers see the flip, and a missing row means on', async () => {
    const { flip } = await setup();
    for (const key of ['inbox.enabled', 'delivery.enabled'] as const) {
      expect(await readSetting(key)).toBe(true);
      await flip(key, false);
      expect(await readSetting(key)).toBe(false);
      await flip(key, true);
      expect(await readSetting(key)).toBe(true);
    }
  });

  test('every kill switch is a boolean setting, so one flip covers them all', () => {
    for (const key of killSwitches) expect(typeof contract[key].default, key).toBe('boolean');
  });
});

describe('a flip and a write in flight', () => {
  test('turning registration off waits for a rechecked account.register that holds the setting row', async () => {
    const { system, subjects, flip } = await setup();
    // As after migrate: the row exists, so there is something to lock.
    await ensureSettingRows(writer());
    const holding = gate();
    const release = gate();
    // The write's recheck reads the switch FOR SHARE and keeps its transaction open.
    const registering = tx(async (t) => {
      const decision = await authorize('account.register', system, subjects.register, { db: t.db, lock: true });
      holding.open();
      await release.opened;
      return decision.ok;
    });
    await holding.opened;
    let flipped = false;
    const flipping = flip('registration.enabled', false).then(() => (flipped = true));
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      expect(flipped).toBe(false);
    } finally {
      release.open();
    }
    expect(await registering).toBe(true);
    await flipping;
    expect(await readSetting('registration.enabled')).toBe(false);
  });
});
