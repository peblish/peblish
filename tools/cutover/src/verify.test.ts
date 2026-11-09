import { newRsaKeyPair } from '@peblish/core/actor-keys';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { importBundle } from './import.ts';
import { remoteCommunity, testBundle, testOrigin } from './test-bundle.ts';
import { verifyImport } from './verify.ts';

beforeEach(truncateAll);

test('every imported key signs a delivery that verifies against the stored public key, and the served documents name it', async () => {
  const bundle = await testBundle();
  await importBundle(bundle, { publicOrigin: testOrigin });
  const report = await verifyImport(bundle);
  expect(report.keys.map((key) => [key.apId, key.pair, key.signature, key.served, key.matchesBundle])).toEqual([
    [`${testOrigin}/actor`, true, true, true, true],
    [`${testOrigin}/c/announcements`, true, true, true, true],
    [`${testOrigin}/c/microblogs`, true, true, true, true],
    [`${testOrigin}/u/Andrew`, true, true, true, true],
    [`${testOrigin}/u/feddit-admin`, true, true, true, true],
  ]);
  // PieFed's instance actor id, /actor, is served by id but the web server does not route it to federation yet.
  expect(report.keys.filter((key) => !key.routed).map((key) => key.apId)).toEqual([`${testOrigin}/actor`]);
  expect(report.follows).toMatchObject([
    { followee: `${testOrigin}/c/announcements`, state: 'accepted', local: true },
    {
      followee: remoteCommunity,
      state: 'accepted',
      local: false,
      host: 'lemmy.test',
      inbox: 'https://lemmy.test/inbox',
      deliverable: true,
    },
  ]);
  expect(report.summary).toEqual({ keys: 5, keysOk: 5, follows: 2, accepted: 2, pending: 0, local: 1, undeliverable: 0, hosts: 1 });
});

test('a private key that is not the stored public key fails the pair and the signature, and a key the bundle does not hold is flagged', async () => {
  const bundle = await testBundle();
  await importBundle(bundle, { publicOrigin: testOrigin });
  const [admin] = await writer()
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.apId, `${testOrigin}/u/feddit-admin`));
  await writer()
    .update(actorKeys)
    .set({ privateKeyPem: (await newRsaKeyPair()).privateKeyPem })
    .where(eq(actorKeys.actorId, admin!.id));
  const other = await testBundle();
  const report = await verifyImport({ ...bundle, communities: other.communities });
  const by = (apId: string) => report.keys.find((key) => key.apId === apId);
  expect(by(`${testOrigin}/u/feddit-admin`)).toMatchObject({ pair: false, signature: false, served: true });
  expect(by(`${testOrigin}/c/microblogs`)).toMatchObject({ pair: true, signature: true, matchesBundle: false });
  expect(report.summary.keysOk).toBe(2);
});
