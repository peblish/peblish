import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedInstance } from '../testing/seed.ts';
import {
  blockedDomains,
  deliveryBlocked,
  deniedMediaDomains,
  instanceBlocked,
  intakeFor,
  mediaAllowed,
  supplierMediaAllowed,
} from './gate.ts';
import { peerControls } from './tables.ts';

beforeEach(truncateAll);

const control = (instanceId: string, values: Partial<typeof peerControls.$inferInsert>) =>
  writer()
    .insert(peerControls)
    .values({ instanceId, ...values });

test('a peer with no row is new: text is taken, media is quarantined, nothing is blocked', async () => {
  await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  expect(await intakeFor(db(), 'https://lemmy.test/u/someone')).toBe('accept');
  expect(await instanceBlocked(db(), 'https://lemmy.test/u/someone')).toBe(false);
  expect(await deliveryBlocked(lemmy.id)).toBe(false);
  expect(await mediaAllowed('lemmy.test')).toBe(false);
  expect(await deniedMediaDomains(db())).toEqual(['lemmy.test']);
});

test('intake: pause answers retry later, block refuses, and only that peer is affected', async () => {
  await seedInstance('feddit.test');
  const paused = await seedInstance('paused.test', false);
  const blocked = await seedInstance('blocked.test', false);
  await seedInstance('other.test', false);
  await control(paused.id, { inboxPaused: true });
  await control(blocked.id, { blocked: true, inboxPaused: true });
  expect(await intakeFor(db(), 'https://paused.test/u/a')).toBe('paused');
  expect(await intakeFor(db(), 'https://blocked.test/u/a')).toBe('blocked');
  expect(await intakeFor(db(), 'https://other.test/u/a')).toBe('accept');
  expect(await intakeFor(db(), 'https://unknown.test/u/a')).toBe('accept');
  expect(await instanceBlocked(db(), 'https://blocked.test/c/x')).toBe(true);
  expect(await instanceBlocked(db(), 'https://paused.test/c/x')).toBe(false);
  expect(await deliveryBlocked(blocked.id)).toBe(true);
  expect(await deliveryBlocked(paused.id)).toBe(false);
  expect(await blockedDomains()).toEqual(['blocked.test']);
});

test('media: approved passes, quarantined and denied do not, subdomains follow the closest known peer, strangers and this server pass', async () => {
  await seedInstance('feddit.test');
  const approved = await seedInstance('lemmy.test', false);
  const quarantined = await seedInstance('piefed.test', false);
  const purged = await seedInstance('purged.test', false);
  const blocked = await seedInstance('blocked.test', false);
  const sub = await seedInstance('cdn.lemmy.test', false);
  await control(approved.id, { media: 'approved' });
  await control(quarantined.id, { media: 'quarantined' });
  await control(purged.id, { media: 'denied', purgedAt: new Date() });
  await control(blocked.id, { media: 'approved', blocked: true });
  expect(await mediaAllowed('lemmy.test')).toBe(true);
  expect(await mediaAllowed('img.lemmy.test')).toBe(true);
  expect(await mediaAllowed('piefed.test')).toBe(false);
  expect(await mediaAllowed('purged.test')).toBe(false);
  expect(await mediaAllowed('blocked.test')).toBe(false);
  // The closest known peer decides: cdn.lemmy.test has no row, so it is quarantined although lemmy.test is approved.
  expect(await mediaAllowed('a.cdn.lemmy.test')).toBe(false);
  await control(sub.id, { media: 'approved' });
  expect(await mediaAllowed('a.cdn.lemmy.test')).toBe(true);
  expect(await mediaAllowed('example.org')).toBe(true);
  expect(await mediaAllowed('feddit.test')).toBe(true);
  expect((await deniedMediaDomains(db())).toSorted()).toEqual(['blocked.test', 'piefed.test', 'purged.test']);
});

test('a supplier: approved passes, quarantined, purged and blocked do not, and an unknown one is refused, unlike an unknown image host', async () => {
  await seedInstance('feddit.test');
  const approved = await seedInstance('lemmy.test', false);
  const purged = await seedInstance('purged.test', false);
  const blocked = await seedInstance('blocked.test', false);
  await seedInstance('piefed.test', false);
  await control(approved.id, { media: 'approved' });
  await control(purged.id, { media: 'denied', purgedAt: new Date() });
  await control(blocked.id, { media: 'approved', blocked: true });
  const answers = async (hosts: string[]) => Promise.all(hosts.map((host) => supplierMediaAllowed(host)));
  expect(await answers(['feddit.test', 'lemmy.test', 'piefed.test', 'purged.test', 'blocked.test', 'stranger.example'])).toEqual([
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
  expect(await mediaAllowed('stranger.example')).toBe(true);
});
