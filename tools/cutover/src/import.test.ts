import { ensureLocalInstance } from '@peblish/core/db/bootstrap';
import { db } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { authAccount, authUser } from '@peblish/core/db/tables/auth';
import { follows } from '@peblish/core/db/tables/follows';
import { communityModerators, modlog } from '@peblish/core/db/tables/moderation';
import { instances } from '@peblish/core/db/tables/instances';
import { peerControls } from '@peblish/core/peers/tables';
import { siteSettings } from '@peblish/core/db/tables/site';
import { readSetting } from '@peblish/core/settings/read';
import { outbox } from '@peblish/core/db/tables/outbox';
import { writer } from '@peblish/core/db/write';
import { auth } from '@peblish/core/identity/auth';
import { recordingTransport, useMailTransport } from '@peblish/core/identity/mail';
import { truncateAll } from '@peblish/core/testing/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { ImportRefused, importBundle, planImport } from './import.ts';
import { remoteCommunity, testBundle, testOrigin } from './test-bundle.ts';

beforeEach(truncateAll);

const followAccepted = async () =>
  (await db().select({ type: outbox.type }).from(outbox)).filter((row) => row.type === 'follow.accepted').length;
const instanceActorId = async () =>
  (
    await db()
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Application')))
  )[0]?.id;
/** The settings.update modlog rows: who changed the federation switch, under what authority. */
const switchChanges = () =>
  db()
    .select({ actorId: modlog.actorId, public: modlog.public, authority: modlog.authority, details: modlog.details })
    .from(modlog)
    .where(eq(modlog.action, 'settings.update'));
/** The settings.updated events in the outbox. */
const settingsEvents = async () =>
  (await db().select({ type: outbox.type, payload: outbox.payload }).from(outbox))
    .filter((row) => row.type === 'settings.updated')
    .map((row) => row.payload);

test('imports the actors with their ids, inboxes and keys and the follows as accepted; a second run changes nothing', async () => {
  const bundle = await testBundle();
  const first = await importBundle(bundle, { publicOrigin: testOrigin });
  expect(first).toMatchObject({
    instanceActor: { created: 1 },
    users: { created: 2 },
    communities: { created: 2 },
    remoteCommunities: { created: 1 },
    follows: { created: 2 },
  });

  const [admin] = await db()
    .select()
    .from(actors)
    .where(eq(actors.apId, `${testOrigin}/u/feddit-admin`));
  expect(admin).toMatchObject({
    name: 'feddit-admin',
    local: true,
    kind: 'Person',
    inboxUrl: `${testOrigin}/u/feddit-admin/inbox`,
    indexable: false,
  });
  expect(admin?.importedAt).not.toBeNull();
  const [key] = await db().select().from(actorKeys).where(eq(actorKeys.actorId, admin!.id));
  expect(key).toMatchObject(bundle.users[0]!.key);
  expect(key?.keyId).toBe(`${testOrigin}/u/feddit-admin#main-key`);
  const [instanceActor] = await db().select({ apId: actors.apId, name: actors.name }).from(actors).where(eq(actors.kind, 'Application'));
  expect(instanceActor).toEqual({ apId: `${testOrigin}/actor`, name: 'feddit.test' });

  const rows = await db().select({ apId: follows.apId, state: follows.state }).from(follows).orderBy(follows.apId);
  expect(rows).toEqual([
    { apId: bundle.follows[1]!.apId, state: 'accepted' },
    { apId: null, state: 'accepted' },
  ]);
  expect(await db().select({ role: communityModerators.role }).from(communityModerators)).toEqual([{ role: 'owner' }, { role: 'owner' }]);
  const users = await db().select({ name: authUser.name, role: authUser.role }).from(authUser).orderBy(authUser.name);
  expect(users).toEqual([
    { name: 'Andrew', role: 'admin' },
    { name: 'feddit-admin', role: 'user' },
  ]);
  // No password is carried: there is no credential account until a reset makes one.
  expect(await db().select().from(authAccount)).toEqual([]);
  expect(await followAccepted()).toBe(2);

  const second = await importBundle(bundle, { publicOrigin: testOrigin });
  expect(second).toMatchObject({
    instanceActor: { created: 0, present: 1 },
    users: { created: 0, present: 2 },
    communities: { created: 0, present: 2 },
    remoteCommunities: { created: 0, present: 1 },
    follows: { created: 0, present: 2 },
  });
  expect(await followAccepted()).toBe(2);
});

test('refuses a bundle for another host unless --rehearsal-host names the target, which rehosts only local ids', async () => {
  const bundle = await testBundle();
  expect(() => planImport(bundle, { publicOrigin: 'https://staging.peblish.test' })).toThrow(ImportRefused);
  expect(() => planImport(bundle, { publicOrigin: 'https://staging.peblish.test', rehearsalHost: 'other.peblish.test' })).toThrow(
    /is not PUBLIC_ORIGIN's host/,
  );
  expect(() => planImport(bundle, { publicOrigin: testOrigin, rehearsalHost: 'feddit.test' })).toThrow(/bundle's own host/);

  const report = await importBundle(bundle, { publicOrigin: 'https://staging.peblish.test', rehearsalHost: 'staging.peblish.test' });
  expect(report.origin).toBe('https://staging.peblish.test');
  const local = await db().select({ apId: actors.apId }).from(actors).where(eq(actors.local, true)).orderBy(actors.apId);
  expect(local.map((row) => row.apId)).toEqual([
    'https://staging.peblish.test/actor',
    'https://staging.peblish.test/c/announcements',
    'https://staging.peblish.test/c/microblogs',
    'https://staging.peblish.test/u/Andrew',
    'https://staging.peblish.test/u/feddit-admin',
  ]);
  const [remote] = await db().select({ apId: actors.apId }).from(actors).where(eq(actors.local, false));
  expect(remote?.apId).toBe(remoteCommunity);
  const emails = await db().select({ email: authUser.email }).from(authUser).orderBy(authUser.email);
  expect(emails.map((row) => row.email)).toEqual(['andrew@staging.peblish.test', 'feddit-admin@staging.peblish.test']);
  const ids = await db().select({ apId: follows.apId }).from(follows);
  expect(ids.map((row) => row.apId)).toContain('https://staging.peblish.test/activities/follow/0b8a3c1e-1d2f-4a5b-9c6d-7e8f90a1b2c3');
});

test('refuses a database whose migrate minted an instance actor, and writes nothing', async () => {
  await ensureLocalInstance(writer(), testOrigin);
  await expect(importBundle(await testBundle(), { publicOrigin: testOrigin })).rejects.toThrow(
    /fresh database migrated without PUBLIC_ORIGIN/,
  );
  expect(await db().select({ kind: actors.kind }).from(actors)).toEqual([{ kind: 'Application' }]);
});

test('refuses to replace the key of an actor already imported', async () => {
  const bundle = await testBundle();
  await importBundle(bundle, { publicOrigin: testOrigin });
  const other = await testBundle();
  const changed = {
    ...bundle,
    users: [{ ...bundle.users[0]!, key: { ...other.users[0]!.key, keyId: bundle.users[0]!.key.keyId } }, bundle.users[1]!],
  };
  await expect(importBundle(changed, { publicOrigin: testOrigin })).rejects.toThrow(/another key/);
});

test('an imported account signs in once a password reset has set its first password', async () => {
  const mail = recordingTransport();
  useMailTransport(mail);
  try {
    await importBundle(await testBundle(), { publicOrigin: testOrigin });
    const { api } = await auth();
    const email = 'andrew@mail.test';
    await expect(api.signInEmail({ body: { email, password: 'a brand new passphrase' } })).rejects.toThrow();
    await api.requestPasswordReset({ body: { email } });
    await expect.poll(() => mail.sent.length).toBe(1);
    const token = new URL(/https:\/\/\S+/.exec(mail.sent[0]?.text ?? '')?.[0] ?? 'about:blank').searchParams.get('token') ?? '';
    await api.resetPassword({ body: { token, newPassword: 'a brand new passphrase' } });
    const signedIn = await api.signInEmail({ body: { email, password: 'a brand new passphrase' } });
    expect(signedIn.user.name).toBe('Andrew');
  } finally {
    useMailTransport(undefined);
  }
});

test("blocks PieFed's banned instances as peers, keeping a peer's other controls, once", async () => {
  const bundle = await testBundle();
  // threads.test is already known here, with its media approved and not blocked.
  const [known] = await writer().insert(instances).values({ domain: 'threads.test', origin: 'https://threads.test' }).returning();
  await writer().insert(peerControls).values({ instanceId: known!.id, media: 'approved' });
  const first = await importBundle(bundle, { publicOrigin: testOrigin });
  expect(first.peerBlocks).toEqual({ created: 2, present: 0, domains: ['spam.test', 'threads.test'] });
  const rows = await db()
    .select({ domain: instances.domain, blocked: peerControls.blocked, media: peerControls.media })
    .from(peerControls)
    .innerJoin(instances, eq(instances.id, peerControls.instanceId))
    .orderBy(instances.domain);
  expect(rows).toEqual([
    { domain: 'spam.test', blocked: true, media: 'quarantined' },
    { domain: 'threads.test', blocked: true, media: 'approved' },
  ]);
  const logged = await db()
    .select({ action: modlog.action, public: modlog.public, targetApId: modlog.targetApId })
    .from(modlog)
    .orderBy(modlog.targetApId);
  expect(logged).toEqual([
    { action: 'peer.update', public: false, targetApId: 'https://spam.test' },
    { action: 'peer.update', public: false, targetApId: 'https://threads.test' },
  ]);
  const events = async () => (await db().select({ type: outbox.type }).from(outbox)).filter((row) => row.type === 'peer.updated').length;
  expect(await events()).toBe(2);

  const second = await importBundle(bundle, { publicOrigin: testOrigin });
  expect(second.peerBlocks).toMatchObject({ created: 0, present: 2 });
  expect(await events()).toBe(2);
});

test('turns the federation switch off first, in its own transaction, so a refused import leaves it off too', async () => {
  const bundle = await testBundle();
  const report = await importBundle(bundle, { publicOrigin: testOrigin });
  expect(report.federation).toEqual({ deliveryEnabled: false, wasOn: true });
  expect(await readSetting('delivery.enabled')).toBe(false);
  expect((await importBundle(bundle, { publicOrigin: testOrigin })).federation).toEqual({
    deliveryEnabled: false,
    wasOn: false,
  });
  // A fresh database has no instance actor yet for a modlog row to name: the switch was written as the runbook's SQL writes it.
  expect(await switchChanges()).toEqual([]);

  // TN9: once the instance actor exists, the import turns it off through settings.update as the
  // system import principal, so the change has its private modlog row and settings.updated.
  await writer().update(siteSettings).set({ value: true }).where(eq(siteSettings.key, 'delivery.enabled'));
  expect((await importBundle(bundle, { publicOrigin: testOrigin })).federation).toEqual({ deliveryEnabled: false, wasOn: true });
  const instanceActor = await instanceActorId();
  const recorded = {
    actorId: instanceActor,
    public: false,
    authority: { kind: 'system', actorId: instanceActor, job: 'import', ref: null },
    details: { public: false, changes: { 'delivery.enabled': { before: true, after: false } } },
  };
  expect(await switchChanges()).toEqual([recorded]);
  expect(await settingsEvents()).toMatchObject([{ keys: ['delivery.enabled'], actorId: instanceActor }]);

  // A database whose migrate minted an instance actor is refused inside the import's transaction.
  await truncateAll();
  await ensureLocalInstance(writer(), testOrigin);
  await writer().insert(siteSettings).values({ key: 'delivery.enabled', value: true });
  await expect(importBundle(await testBundle(), { publicOrigin: testOrigin })).rejects.toThrow(
    /fresh database migrated without PUBLIC_ORIGIN/,
  );
  expect(await readSetting('delivery.enabled')).toBe(false);
  const minted = await instanceActorId();
  expect(await switchChanges()).toEqual([{ ...recorded, actorId: minted, authority: { ...recorded.authority, actorId: minted } }]);
});
