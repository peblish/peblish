import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { instances } from '@peblish/core/db/tables/instances';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, stubFetch, webfingerAnswer } from '@peblish/core/testing/seed-fed-a';
import { readFixture } from '../test/manifest.ts';
import { ActorResolveError, resolveRemoteActor } from './resolve.ts';
import { BlockedDestinationError } from './safe-fetch.ts';

const { publicKeyPem } = rsaKeys();
const lab = actorDocument('lemmy.test', 'lab', { kind: 'Group', publicKeyPem });
const peer = (extra = {}) => stubFetch({ [lab.id]: { body: lab }, ...nodeInfoRoutes('lemmy.test', 'lemmy', '0.19.21'), ...extra });

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

describe('resolving an actor', () => {
  test('fetches, stores the actor, its key and its instance software, and does not fetch again while fresh', async () => {
    const { fetch, requests } = peer();
    const resolved = await resolveRemoteActor(lab.id, { fetch });
    expect(resolved).toMatchObject({ apId: lab.id, kind: 'Group', local: false, deleted: false, inboxUrl: `${lab.id}/inbox` });
    expect(requests.map((request) => request.url)).toEqual([
      lab.id,
      'https://lemmy.test/.well-known/nodeinfo',
      'https://lemmy.test/nodeinfo/2.1',
    ]);
    expect(requests[0]?.headers.get('accept')).toContain('application/activity+json');
    expect(await db().select({ keyId: actorKeys.keyId }).from(actorKeys)).toEqual([{ keyId: `${lab.id}#main-key` }]);
    const [instance] = await db().select().from(instances).where(eq(instances.domain, 'lemmy.test'));
    expect(instance).toMatchObject({ software: 'lemmy', softwareVersion: '0.19.21' });

    expect(await resolveRemoteActor(lab.id, { fetch })).toMatchObject({ id: resolved.id });
    expect(requests).toHaveLength(3);
    await resolveRemoteActor(lab.id, { fetch, refresh: true });
    expect(requests).toHaveLength(4);
  });

  test('reads a real Lemmy Person from the corpus', async () => {
    const person = readFixture('wire/lemmy-0.19.21/fetched/fetched-0001-person.json') as { id: string };
    const { fetch } = stubFetch({ [person.id]: { body: person } });
    expect(await resolveRemoteActor(person.id, { fetch })).toMatchObject({ apId: person.id, kind: 'Person' });
  });

  test('two callers asking for the same new actor at once fetch it once', async () => {
    const { fetch, requests } = peer();
    const [a, b] = await Promise.all([resolveRemoteActor(lab.id, { fetch }), resolveRemoteActor(lab.id, { fetch })]);
    expect(a.id).toBe(b.id);
    expect(requests.filter((request) => request.url === lab.id)).toHaveLength(1);
    expect(await db().select().from(actors).where(eq(actors.apId, lab.id))).toHaveLength(1);
  });

  test('a handle goes through WebFinger, and the sigil picks between a person and a community of one name', async () => {
    const person = actorDocument('lemmy.test', 'lab', { publicKeyPem });
    const finger = webfingerAnswer('acct:lab@lemmy.test', [
      { href: person.id, type: 'Person' },
      { href: lab.id, type: 'Group' },
    ]);
    const { fetch, requests } = peer({
      'https://lemmy.test/.well-known/webfinger?resource=acct%3Alab%40lemmy.test': { type: 'application/jrd+json', body: finger },
      [person.id]: { body: person },
    });
    expect(await resolveRemoteActor('!lab@lemmy.test', { fetch })).toMatchObject({ apId: lab.id, kind: 'Group' });
    expect(await resolveRemoteActor('@lab@lemmy.test', { fetch })).toMatchObject({ apId: person.id, kind: 'Person' });
    expect(requests[0]?.url).toBe('https://lemmy.test/.well-known/webfinger?resource=acct%3Alab%40lemmy.test');
  });

  test.each([
    ['a 404', { status: 404 }, 'not_found'],
    ['a 410', { status: 410 }, 'gone'],
    ['a 500', { status: 500 }, 'unreachable'],
    ['a 429', { status: 429 }, 'unreachable'],
    ['a 403', { status: 403 }, 'invalid'],
    ['a page of HTML', { type: 'text/html', body: '<html></html>' }, 'invalid'],
    ['JSON that is not an actor', { body: { type: 'Note', id: lab.id } }, 'invalid'],
    ['an actor of another origin', { body: actorDocument('elsewhere.test', 'lab', { kind: 'Group', publicKeyPem }) }, 'invalid'],
    ['an actor whose inbox is on another origin', { body: { ...lab, inbox: 'https://elsewhere.test/inbox' } }, 'invalid'],
    [
      'an actor whose key names another owner',
      { body: { ...lab, publicKey: { ...lab.publicKey, owner: 'https://lemmy.test/c/other' } } },
      'invalid',
    ],
  ] as const)('%s is %s', async (_name, answer, reason) => {
    const { fetch } = stubFetch({ [lab.id]: answer });
    const error = await resolveRemoteActor(lab.id, { fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActorResolveError);
    expect((error as ActorResolveError).reason).toBe(reason);
    expect(await db().select().from(actors).where(eq(actors.apId, lab.id))).toHaveLength(0);
  });

  test('a blocked destination is permanent, a network failure is not, and a stale copy outlives an unreachable peer', async () => {
    const blocked = await resolveRemoteActor(lab.id, {
      fetch: async () => {
        throw new BlockedDestinationError('private');
      },
    }).catch((caught: unknown) => caught);
    expect(blocked).toMatchObject({ reason: 'blocked', transient: false });

    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await resolveRemoteActor(lab.id, { fetch: down }).catch((caught: unknown) => caught)).toMatchObject({
      reason: 'unreachable',
      transient: true,
    });

    const { fetch } = peer();
    const held = await resolveRemoteActor(lab.id, { fetch });
    expect(await resolveRemoteActor(lab.id, { fetch: down, maxAgeMs: 0 })).toMatchObject({ id: held.id });
  });

  test('an id on this server is never fetched, and one we hold is returned as stored', async () => {
    const { fetch, requests } = stubFetch({});
    const error = await resolveRemoteActor('https://fed-a.test/u/nobody', { fetch }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'not_found' });
    expect(requests).toHaveLength(0);
    expect(await resolveRemoteActor('https://fed-a.test/', { fetch })).toMatchObject({ kind: 'Application', local: true });
  });

  test('a peer without NodeInfo still resolves, and is not asked again within ten minutes', async () => {
    const { fetch, requests } = stubFetch({ [lab.id]: { body: lab } });
    await resolveRemoteActor(lab.id, { fetch });
    await resolveRemoteActor(lab.id, { fetch, refresh: true });
    expect(requests.filter((request) => request.url.endsWith('/.well-known/nodeinfo'))).toHaveLength(1);
    const [instance] = await db().select().from(instances).where(eq(instances.domain, 'lemmy.test'));
    expect(instance?.software).toBeNull();
  });
});
