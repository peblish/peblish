import { count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { actorKeys, actors, communityLanguages } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { rsaKeys, seedLocalInstance } from '../testing/seed-fed-a.ts';
import { checkRemoteActor, deleteRemoteActor, storeRemoteActor, type RemoteActorInput } from './actors.ts';
import { isDormant, storeInstanceSoftware } from './instances.ts';

const { publicKeyPem } = rsaKeys();
const apId = 'https://lemmy.test/c/lab';
const input = (extra: Partial<RemoteActorInput> = {}): RemoteActorInput => ({
  apId,
  kind: 'Group',
  name: 'lab',
  displayName: 'Lab',
  summaryHtml: '<p>hi</p>',
  inboxUrl: `${apId}/inbox`,
  sharedInboxUrl: 'https://lemmy.test/inbox',
  outboxUrl: `${apId}/outbox`,
  followersUrl: `${apId}/followers`,
  featuredUrl: null,
  moderatorsUrl: `${apId}/moderators`,
  iconUrl: null,
  bannerUrl: null,
  sensitive: false,
  nsfl: false,
  discoverable: true,
  indexable: true,
  postingRestrictedToMods: false,
  postingWarning: null,
  languages: ['en', 'de'],
  bot: false,
  publishedAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: null,
  publicKey: { keyId: `${apId}#main-key`, ownerApId: apId, pem: publicKeyPem },
  raw: { type: 'Group' },
  ...extra,
});

/** The local instance and the grants of the instance importing, one per action. */
async function world() {
  const local = await seedLocalInstance();
  const principal = await local.importer();
  return {
    ...local,
    store: async (subject = apId) => {
      const decision = await authorize('remote.actor_store', principal, { apId: subject });
      if (!decision.ok) throw new Error(decision.reason);
      return decision.grant;
    },
    remove: async (subject = apId) => {
      const decision = await authorize('remote.actor_delete', principal, { apId: subject });
      if (!decision.ok) throw new Error(decision.reason);
      return decision.grant;
    },
    software: async (origin = 'https://lemmy.test') => {
      const decision = await authorize('remote.instance_store', principal, { origin });
      if (!decision.ok) throw new Error(decision.reason);
      return decision.grant;
    },
  };
}

const eventTypes = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

beforeEach(truncateAll);

describe('the remote actor store', () => {
  test('stores an actor, its key, its languages and its instance, and says it was created', async () => {
    const w = await world();
    await storeRemoteActor(await w.store(), input());
    const [actor] = await db().select().from(actors).where(eq(actors.apId, apId));
    expect(actor).toMatchObject({
      kind: 'Group',
      local: false,
      name: 'lab',
      inboxUrl: `${apId}/inbox`,
      sharedInboxUrl: 'https://lemmy.test/inbox',
    });
    expect(actor?.fetchedAt).toBeInstanceOf(Date);
    const [key] = await db().select().from(actorKeys).where(eq(actorKeys.actorId, actor!.id));
    expect(key).toMatchObject({ keyId: `${apId}#main-key`, algorithm: 'rsa', publicKeyPem, privateKeyPem: null });
    const languages = await db().select().from(communityLanguages).where(eq(communityLanguages.communityId, actor!.id));
    expect(languages.map((row) => row.language).sort()).toEqual(['de', 'en']);
    const [instance] = await db().select().from(instances).where(eq(instances.domain, 'lemmy.test'));
    expect(instance).toMatchObject({ local: false, origin: 'https://lemmy.test', software: null });
    expect(await eventTypes()).toEqual(['actor.created']);
    expect((await outboxEvents())[0]).toMatchObject({ actorId: actor!.id, kind: 'Group', local: false });
  });

  test('storing it again updates: one row, the new profile, a rotated key, fewer languages', async () => {
    const w = await world();
    await storeRemoteActor(await w.store(), input());
    const rotated = rsaKeys().publicKeyPem;
    const change = input({
      displayName: 'Lab 2',
      languages: ['de'],
      publicKey: { keyId: `${apId}#main-key`, ownerApId: apId, pem: rotated },
    });
    await storeRemoteActor(await w.store(), change);
    const rows = await db().select().from(actors).where(eq(actors.apId, apId));
    expect(rows.map((row) => row.displayName)).toEqual(['Lab 2']);
    const keys = await db().select().from(actorKeys).where(eq(actorKeys.actorId, rows[0]!.id));
    expect(keys.map((key) => key.publicKeyPem)).toEqual([rotated]);
    const languages = await db().select().from(communityLanguages).where(eq(communityLanguages.communityId, rows[0]!.id));
    expect(languages.map((row) => row.language)).toEqual(['de']);
    expect(await eventTypes()).toEqual(['actor.created', 'actor.updated']);
  });

  test('three fetches of the same new actor racing end with one actor, one key and one created event', async () => {
    const w = await world();
    const grant = await w.store();
    await Promise.all([storeRemoteActor(grant, input()), storeRemoteActor(grant, input()), storeRemoteActor(grant, input())]);
    const [actorCount] = await db().select({ n: count() }).from(actors).where(eq(actors.apId, apId));
    const [keyCount] = await db().select({ n: count() }).from(actorKeys);
    expect({ actors: actorCount?.n, keys: keyCount?.n }).toEqual({ actors: 1, keys: 1 });
    expect((await eventTypes()).sort()).toEqual(['actor.created', 'actor.updated', 'actor.updated']);
  });

  test('a document cannot take over a local actor, change a stored kind, or be stored under another grant', async () => {
    const w = await world();
    const local = 'https://fed-a.test/u/alice';
    await seedActor(w.instance, 'Person', 'alice', { apId: local });
    const claim = input({
      apId: local,
      kind: 'Person',
      name: 'alice',
      inboxUrl: `${local}/inbox`,
      sharedInboxUrl: null,
      outboxUrl: null,
      followersUrl: null,
      moderatorsUrl: null,
      publicKey: null,
    });
    await expect(storeRemoteActor(await w.store(local), claim)).rejects.toThrow(/on this server/);
    await storeRemoteActor(await w.store(), input());
    await expect(storeRemoteActor(await w.store(), input({ kind: 'Person' }))).rejects.toThrow(/stored as a Group/);
    await expect(storeRemoteActor(await w.store('https://lemmy.test/c/other'), input())).rejects.toThrow(/grant names/);
    expect(await eventTypes()).toEqual(['actor.created']);
  });

  test.each([
    ['an inbox on another origin', { inboxUrl: 'https://elsewhere.test/inbox' }],
    ['a shared inbox on another origin', { sharedInboxUrl: 'https://elsewhere.test/inbox' }],
    ['a followers collection on another origin', { followersUrl: 'https://elsewhere.test/f' }],
    [
      'a key owned by someone else',
      { publicKey: { keyId: `${apId}#main-key`, ownerApId: 'https://lemmy.test/c/other', pem: publicKeyPem } },
    ],
    ['a key id on another origin', { publicKey: { keyId: 'https://elsewhere.test/k', ownerApId: apId, pem: publicKeyPem } }],
    ['an id with credentials', { apId: 'https://user:pw@lemmy.test/c/lab' }],
    ['an id that is not https', { apId: 'http://lemmy.test/c/lab' }],
    ['an empty name', { name: ' ' }],
  ] as const)('checkRemoteActor refuses %s', (_name, extra) => {
    expect(checkRemoteActor(input(extra))).toEqual(expect.any(String));
  });

  test('checkRemoteActor accepts what a community and an instance actor look like', () => {
    expect(checkRemoteActor(input())).toBeNull();
    const instance = input({
      apId: 'https://piefed.test/',
      kind: 'Application',
      inboxUrl: 'https://piefed.test/inbox',
      sharedInboxUrl: null,
      outboxUrl: null,
      followersUrl: null,
      moderatorsUrl: null,
      publicKey: { keyId: 'https://piefed.test/#main-key', ownerApId: 'https://piefed.test/', pem: publicKeyPem },
    });
    expect(checkRemoteActor(instance)).toBeNull();
  });

  test('only the instance importing is authorized', async () => {
    const w = await world();
    const person = await seedActor(w.instance, 'Person', 'someone');
    expect(await authorize('remote.actor_store', localUser(person.id), { apId })).toEqual({ ok: false, reason: 'auth.required' });
    const scheduled = await systemPrincipal(db(), 'scheduled');
    expect(await authorize('remote.actor_store', scheduled, { apId })).toEqual({ ok: false, reason: 'auth.required' });
  });
});

describe('deleting an actor and recording instance software', () => {
  test('a remote actor’s Delete scrubs the profile, keeps the id and key, and is recorded once', async () => {
    const w = await world();
    await storeRemoteActor(await w.store(), input());
    expect(await deleteRemoteActor(await w.remove(), undefined)).toEqual({ deleted: true });
    expect(await deleteRemoteActor(await w.remove(), undefined)).toEqual({ deleted: false });
    const [actor] = await db().select().from(actors).where(eq(actors.apId, apId));
    expect(actor).toMatchObject({ displayName: null, summaryHtml: null, raw: null, name: 'lab' });
    expect(actor?.deletedAt).toBeInstanceOf(Date);
    expect(await db().select().from(actorKeys).where(eq(actorKeys.actorId, actor!.id))).toHaveLength(1);
    expect(await eventTypes()).toEqual(['actor.created', 'actor.deleted']);
  });

  test('instance software is stored lowercase, with an event only when it changes; nothing is dormant yet', async () => {
    const w = await world();
    expect(await storeInstanceSoftware(await w.software(), { software: 'Lemmy', version: '0.19.21' })).toMatchObject({ changed: true });
    expect(await storeInstanceSoftware(await w.software(), { software: 'lemmy', version: '0.19.21' })).toMatchObject({ changed: false });
    expect(await storeInstanceSoftware(await w.software(), { software: 'lemmy', version: '0.19.22' })).toMatchObject({ changed: true });
    const [instance] = await db().select().from(instances).where(eq(instances.domain, 'lemmy.test'));
    expect(instance).toMatchObject({ software: 'lemmy', softwareVersion: '0.19.22' });
    expect(await eventTypes()).toEqual(['instance.updated', 'instance.updated']);
    expect(await isDormant(instance!.id)).toBe(false);
  });
});
