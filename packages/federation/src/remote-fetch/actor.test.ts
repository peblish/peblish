import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { truncateAll } from '@peblish/core/testing/db';
import { outboxEvents } from '@peblish/core/testing/seed-az';
import { deleteRemoteActor } from '@peblish/core/remote/actors';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { importGrant } from '../actors/grants.ts';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { refreshRemoteActor } from './actor.ts';

const { publicKeyPem } = rsaKeys();
const document = (name = 'Bob') => actorDocument('lemmy.test', 'bob', { publicKeyPem, extra: { name } });
const bob = document().id;
const serving = (answer: Parameters<typeof stubFetch>[0][string]) => stubFetch({ [bob]: answer, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
const row = async () => (await db().select().from(actors).where(eq(actors.apId, bob)))[0];
const ledger = () => db().select().from(deletionLedger);
const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance('rem.test');
  await resolveRemoteActor(bob, { fetch: serving({ body: document() }).fetch });
});

describe('fetching an actor again', () => {
  test('stores what the peer serves now, whatever the age of the copy', async () => {
    expect((await row())?.displayName).toBe('Bob');
    expect(await refreshRemoteActor(bob, { fetch: serving({ body: document('Robert') }).fetch })).toBe('refreshed');
    expect((await row())?.displayName).toBe('Robert');
  });

  test('keeps the copy when the peer is down', async () => {
    expect(await refreshRemoteActor(bob, { fetch: serving({ status: 503 }).fetch })).toBe('unreachable');
    expect((await row())?.deletedAt).toBeNull();
  });

  test('treats a 410 as the actor’s deletion, once, and records it', async () => {
    const gone = serving({ status: 410, body: { type: 'Tombstone', id: bob } });
    expect(await refreshRemoteActor(bob, { fetch: gone.fetch })).toBe('deleted');
    expect(await row()).toMatchObject({ displayName: null, deletedAt: expect.any(Date) });
    expect(await ledger()).toMatchObject([
      { subjectKind: 'actor', subjectApId: bob, details: { cause: 'Tombstone', removeContent: false } },
    ]);

    expect(await refreshRemoteActor(bob, { fetch: gone.fetch })).toBe('deleted');
    expect(await ledger()).toHaveLength(1);
    expect((await types()).filter((type) => type === 'actor.deleted')).toHaveLength(1);
  });

  test('treats a Tombstone served with 200 the same way', async () => {
    expect(await refreshRemoteActor(bob, { fetch: serving({ body: { type: 'Tombstone', id: bob, formerType: 'Person' } }).fetch })).toBe(
      'deleted',
    );
    expect((await row())?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('an actor we hold as deleted', () => {
  beforeEach(async () => {
    await refreshRemoteActor(bob, { fetch: serving({ status: 410 }).fetch });
  });

  test('comes back when its server serves a valid document again, from one request', async () => {
    const back = serving({ body: document('Bob again') });
    expect(await refreshRemoteActor(bob, { fetch: back.fetch })).toBe('undeleted');
    expect(await row()).toMatchObject({ displayName: 'Bob again', deletedAt: null });
    expect(back.requests.filter((request) => request.url === bob)).toHaveLength(1);
    expect((await ledger()).map((entry) => entry.reason)).toEqual(['remote.actor_deleted', 'remote.actor_undeleted']);
  });

  test('stays deleted while the server is down or still says 410', async () => {
    expect(await refreshRemoteActor(bob, { fetch: serving({ status: 503 }).fetch })).toBe('unreachable');
    expect(await refreshRemoteActor(bob, { fetch: serving({ status: 410 }).fetch })).toBe('deleted');
    expect((await row())?.deletedAt).toBeInstanceOf(Date);
    expect(await ledger()).toHaveLength(1);
  });
});

/** The actor's own signed Delete (what the inbound Delete handler applies). */
const signedDelete = async () => deleteRemoteActor(await importGrant('remote.actor_delete', { apId: bob }), { cause: 'Delete' });

describe('an actor that sent its own signed Delete', () => {
  test('stays deleted when its server serves a valid document, however often it is fetched', async () => {
    await signedDelete();
    const served = serving({ body: document('Bob again') });
    expect(await refreshRemoteActor(bob, { fetch: served.fetch })).toBe('deleted');
    expect(await refreshRemoteActor(bob, { fetch: served.fetch })).toBe('deleted');
    expect(await row()).toMatchObject({ displayName: null, deletedAt: expect.any(Date) });
    expect((await ledger()).map((entry) => entry.reason)).toEqual(['remote.actor_deleted']);
  });

  test('also when a 410 or a Tombstone deleted it first: the signed Delete is recorded over it and wins', async () => {
    await refreshRemoteActor(bob, { fetch: serving({ status: 410 }).fetch });
    await signedDelete();
    expect(await ledger()).toMatchObject([{ details: { cause: 'Tombstone' } }, { details: { cause: 'Delete' } }]);
    expect(await refreshRemoteActor(bob, { fetch: serving({ body: document('Bob again') }).fetch })).toBe('deleted');
    expect((await row())?.deletedAt).toBeInstanceOf(Date);
    // A Tombstone after a signed Delete adds nothing to the record.
    await refreshRemoteActor(bob, { fetch: serving({ status: 410 }).fetch });
    expect(await ledger()).toHaveLength(2);
  });

  test('wins over a refresh that was already fetching a valid document when the Delete arrived', async () => {
    await refreshRemoteActor(bob, { fetch: serving({ status: 410 }).fetch });
    const valid = serving({ body: document('Bob again') });
    // The Delete lands while the document is on the wire: after the fetch began, before the refresh decides.
    const racing: typeof valid.fetch = async (url, init) => {
      const answer = await valid.fetch(url, init);
      if (String(url) === bob) await signedDelete();
      return answer;
    };
    expect(await refreshRemoteActor(bob, { fetch: racing })).toBe('deleted');
    expect(await row()).toMatchObject({ displayName: null, deletedAt: expect.any(Date) });
    expect((await ledger()).map((entry) => entry.reason)).toEqual(['remote.actor_deleted', 'remote.actor_deleted']);
  });
});
