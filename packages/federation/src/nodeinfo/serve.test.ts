import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { authSession, authUser } from '@peblish/core/db/tables/auth';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedComment, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance } from '@peblish/core/testing/seed-fed-a';
import { eq } from 'drizzle-orm';
import { nodeInfo, nodeInfoDiscovery, resetNodeInfoCache, serveNodeInfo } from './serve.ts';

const origin = 'https://fed-a.test';
const day = 24 * 60 * 60 * 1000;

/** A local person with an account; `active` is how long ago its session was last used. */
async function person(here: Awaited<ReturnType<typeof seedLocalInstance>>['instance'], name: string, active: number | null) {
  const userId = randomUUID();
  await writer()
    .insert(authUser)
    .values({ id: userId, name, email: `${name}@fed-a.test`, emailVerified: true });
  const actor = await seedActor(here, 'Person', name, { userId });
  if (active !== null) {
    await writer()
      .insert(authSession)
      .values({ userId, token: `token-${name}`, expiresAt: new Date(Date.now() + day), updatedAt: new Date(Date.now() - active) });
  }
  return actor;
}

beforeEach(async () => {
  await truncateAll();
  resetNodeInfoCache();
});

describe('nodeinfo', () => {
  test('2.1 says peblish in lowercase, closed registration and the usage Lemmy and PieFed read', async () => {
    const { instance: here } = await seedLocalInstance('fed-a.test');
    const alice = await person(here, 'alice', 2 * day);
    await person(here, 'bob', 60 * day);
    await person(here, 'carol', null);
    const news = await seedActor(here, 'Group', 'news');
    const post = await seedPost(here, news, alice);
    await seedPost(here, news, alice, { removedAt: new Date() });
    await seedComment(here, post, alice);
    const peer = await seedInstance('peer.test', false);
    await seedPost(peer, news, await seedActor(peer, 'Person', 'dave'));

    const info = await nodeInfo(db(), '2.1');
    expect(info).toMatchObject({
      version: '2.1',
      software: { name: 'peblish', repository: 'https://github.com/peblish/peblish' },
      protocols: ['activitypub'],
      openRegistrations: false,
      services: { inbound: [], outbound: [] },
    });
    expect(info.software.version).toMatch(/^\d+\.\d+\.\d+/);
    // alice used a session and wrote a post inside a month; bob's session is two months old; carol never signed in.
    expect(info.usage).toEqual({ users: { total: 3, activeMonth: 1, activeHalfyear: 2 }, localPosts: 1, localComments: 1 });
  });

  test('a post or comment keeps its author active without a session', async () => {
    const { instance: here } = await seedLocalInstance('fed-a.test');
    const dana = await person(here, 'dana', null);
    const news = await seedActor(here, 'Group', 'news');
    await seedPost(here, news, dana);
    expect((await nodeInfo(db(), '2.1')).usage.users).toEqual({ total: 1, activeMonth: 1, activeHalfyear: 1 });
  });

  test('2.0 has the same facts without the repository, and the node name is the instance actor name', async () => {
    const { instanceActor } = await seedLocalInstance('fed-a.test');
    const info = await nodeInfo(db(), '2.0');
    expect(info.version).toBe('2.0');
    expect(info.software).not.toHaveProperty('repository');
    expect(info.metadata.nodeName).toBe('fed-a.test');
    await writer().update(actors).set({ displayName: 'Feddit' }).where(eq(actors.id, instanceActor.id));
    expect((await nodeInfo(db(), '2.1')).metadata.nodeName).toBe('Feddit');
  });

  test('discovery links both documents', () => {
    expect(nodeInfoDiscovery(origin)).toEqual({
      links: [
        { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${origin}/nodeinfo/2.0` },
        { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${origin}/nodeinfo/2.1` },
      ],
    });
  });

  test('the endpoint serves discovery and both versions with their profile, and 404s another version', async () => {
    await seedLocalInstance('fed-a.test');
    const discovery = await serveNodeInfo(db(), origin, '/.well-known/nodeinfo');
    expect(discovery.headers.get('content-type')).toContain('application/json');
    expect(((await discovery.json()) as { links: unknown[] }).links).toHaveLength(2);
    const two = await serveNodeInfo(db(), origin, '/nodeinfo/2.1');
    expect(two.headers.get('content-type')).toBe('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
    expect(((await two.json()) as { version: string }).version).toBe('2.1');
    expect((await serveNodeInfo(db(), origin, '/nodeinfo/2.0')).status).toBe(200);
    expect((await serveNodeInfo(db(), origin, '/nodeinfo/1.0')).status).toBe(404);
  });

  test('counts are cached for a minute', async () => {
    const { instance: here } = await seedLocalInstance('fed-a.test');
    const first = await (await serveNodeInfo(db(), origin, '/nodeinfo/2.1')).text();
    await person(here, 'erin', 0);
    expect(await (await serveNodeInfo(db(), origin, '/nodeinfo/2.1')).text()).toBe(first);
    resetNodeInfoCache();
    expect(await (await serveNodeInfo(db(), origin, '/nodeinfo/2.1')).text()).not.toBe(first);
  });
});
