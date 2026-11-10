import { newRsaKeyPair } from '@peblish/core/actor-keys';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { instances } from '@peblish/core/db/tables/instances';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { importBundle } from './import.ts';
import { remoteCommunity, testBundle, testOrigin } from './test-bundle.ts';
import { keyPasses, verifyImport } from './verify.ts';

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
  // Every id, PieFed's instance actor at /actor included, is routed to federation.
  expect(report.keys.every((key) => key.routed)).toBe(true);
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
  expect([report.ok, report.problems]).toEqual([true, []]);
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
  expect(report.ok).toBe(false);
});

test('an actor the bundle expects that is missing, a missing key row and a key without its private half each fail verify', async () => {
  const bundle = await testBundle();
  await importBundle(bundle, { publicOrigin: testOrigin });
  const idOf = async (apId: string) => (await writer().select({ id: actors.id }).from(actors).where(eq(actors.apId, apId)))[0]!.id;
  await writer()
    .delete(actorKeys)
    .where(eq(actorKeys.actorId, await idOf(`${testOrigin}/c/microblogs`)));
  await writer()
    .update(actorKeys)
    .set({ privateKeyPem: null })
    .where(eq(actorKeys.actorId, await idOf(`${testOrigin}/u/Andrew`)));
  const ghost = { ...bundle.users[1]!, apId: `${testOrigin}/u/ghost`, name: 'ghost' };
  const report = await verifyImport({ ...bundle, users: [...bundle.users, ghost] });
  expect(report.problems).toEqual([
    { apId: `${testOrigin}/u/ghost`, problem: 'actor missing' },
    { apId: `${testOrigin}/c/microblogs`, problem: 'key missing' },
    { apId: `${testOrigin}/u/Andrew`, problem: 'private key missing' },
  ]);
  // The other three keys still pass; verify fails all the same.
  expect([report.summary.keys, report.summary.keysOk, report.ok]).toEqual([3, 3, false]);
});

test('verify fails when it finds nothing to check, and a key that is not routed fails', async () => {
  await writer()
    .insert(instances)
    .values({ domain: new URL(testOrigin).host, origin: testOrigin, local: true });
  const empty = await verifyImport(null);
  expect([empty.keys, empty.problems, empty.ok]).toEqual([[], [], false]);
  const passing = {
    apId: `${testOrigin}/u/Andrew`,
    kind: 'Person',
    keyId: 'k',
    fingerprint: 'f',
    pair: true,
    signature: true,
    served: true,
    routed: true,
    matchesBundle: true,
  };
  expect([keyPasses(passing), keyPasses({ ...passing, routed: false })]).toEqual([true, false]);
});
