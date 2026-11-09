import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor } from '@peblish/core/testing/seed';
import { seedLocalInstance } from '@peblish/core/testing/seed-fed-a';
import { eq } from 'drizzle-orm';
import { actorLink, parseHandle } from './client.ts';
import { serveWebFinger, webfingerFor } from './serve.ts';

const origin = 'https://fed-a.test';
const find = (resource: string) => webfingerFor(db(), origin, resource);

async function world() {
  const { instance: here } = await seedLocalInstance('fed-a.test');
  const alice = await seedActor(here, 'Person', 'alice');
  const news = await seedActor(here, 'Group', 'news');
  const admin = await seedActor(here, 'Person', 'feddit-admin', { apId: `${origin}/u/feddit-admin`, importedAt: new Date() });
  return { here, alice, news, admin };
}

beforeEach(truncateAll);

describe('webfinger', () => {
  test('a Person resolves to its profile page and its actor, the way Lemmy writes the links', async () => {
    const w = await world();
    expect(await find('acct:alice@fed-a.test')).toEqual({
      subject: 'acct:alice@fed-a.test',
      aliases: [`${origin}/u/alice`, w.alice.apId],
      links: [
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `${origin}/u/alice` },
        {
          rel: 'self',
          type: 'application/activity+json',
          href: w.alice.apId,
          properties: { 'https://www.w3.org/ns/activitystreams#type': 'Person' },
        },
      ],
    });
  });

  test('a community resolves with the Group type, and the name matches in any case', async () => {
    const w = await world();
    const jrd = await find('acct:News@FED-A.test');
    expect(jrd?.links.at(-1)).toMatchObject({ href: w.news.apId, properties: { 'https://www.w3.org/ns/activitystreams#type': 'Group' } });
    expect(jrd?.links[0]?.href).toBe(`${origin}/c/news`);
  });

  test('an imported actor resolves to its stored /u/ URL, once in the aliases', async () => {
    const w = await world();
    const jrd = await find('acct:feddit-admin@fed-a.test');
    expect(jrd?.aliases).toEqual([w.admin.apId]);
    expect(jrd?.links.at(-1)?.href).toBe(`${origin}/u/feddit-admin`);
  });

  test('the instance actor resolves by the host as its name', async () => {
    await world();
    const jrd = await find('acct:fed-a.test@fed-a.test');
    expect(jrd?.links).toEqual([
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${origin}/`,
        properties: { 'https://www.w3.org/ns/activitystreams#type': 'Application' },
      },
    ]);
  });

  test('an actor URL or its page works as the resource; another host, an unknown name and a deleted account do not resolve', async () => {
    const w = await world();
    expect((await find(w.alice.apId))?.subject).toBe('acct:alice@fed-a.test');
    expect((await find(`${origin}/u/alice`))?.subject).toBe('acct:alice@fed-a.test');
    expect(await find('acct:alice@other.test')).toBeNull();
    expect(await find('acct:nobody@fed-a.test')).toBeNull();
    expect(await find('https://other.test/u/alice')).toBeNull();
    expect(await find('alice')).toBeNull();
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.alice.id));
    expect(await find('acct:alice@fed-a.test')).toBeNull();
  });

  test('our own client reads what we serve: the Person for @name, the Group for !name', async () => {
    await world();
    const jrd = await find('acct:news@fed-a.test');
    expect(actorLink(jrd, parseHandle('!news@fed-a.test')!.kind)).toBe(`${origin}/ap/c.news`);
  });
});

describe('the endpoint', () => {
  const url = (query: string) => new URL(`${origin}/.well-known/webfinger${query}`);

  test('answers application/jrd+json with CORS, narrows by rel, and refuses a missing resource', async () => {
    await world();
    const ok = await serveWebFinger(db(), origin, url('?resource=acct:alice@fed-a.test'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/jrd+json');
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    const narrowed = await serveWebFinger(db(), origin, url('?resource=acct:alice@fed-a.test&rel=self'));
    expect(((await narrowed.json()) as { links: { rel: string }[] }).links.map((link) => link.rel)).toEqual(['self']);
    expect((await serveWebFinger(db(), origin, url(''))).status).toBe(400);
    expect((await serveWebFinger(db(), origin, url('?resource=acct:nobody@fed-a.test'))).status).toBe(404);
  });
});
