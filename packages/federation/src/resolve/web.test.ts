import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { writer } from '@peblish/core/db/write';
import { parseLookup } from '@peblish/core/resolve/parse';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, stubFetch, webfingerAnswer } from '@peblish/core/testing/seed-fed-a';
import { seedCommunityRemoval } from '@peblish/core/testing/seed-az';
import { BlockedDestinationError } from '../actors/safe-fetch.ts';
import { listCommunities } from '@peblish/core/directory/read';
import { defaultQuery } from '@peblish/core/directory/input';
import { forgetNodeInfoFailures } from '../nodeinfo/client.ts';
import { readFixture } from '../test/manifest.ts';
import { lab, lemmy, lemmyNote, lemmyPage, lemmyuser } from '../remote-fetch/test-support.ts';
import { maxRequests } from './limit.ts';
import { resolveLookup } from './web.ts';

const { publicKeyPem } = rsaKeys();
const labDocument = (extra = {}) => actorDocument('lemmy.test', 'lab', { kind: 'Group', publicKeyPem, extra });
const userDocument = actorDocument('lemmy.test', 'lemmyuser', { publicKeyPem });
const finger = (name: string, href: string, type: 'Person' | 'Group') => ({
  [`https://lemmy.test/.well-known/webfinger?resource=acct%3A${name}%40lemmy.test`]: {
    type: 'application/jrd+json',
    body: webfingerAnswer(`acct:${name}@lemmy.test`, [{ href, type }]),
  },
});

/** A Lemmy that serves the community lab, its user and `extra`; every request is recorded. */
const peer = (extra: Parameters<typeof stubFetch>[0] = {}, community = labDocument()) =>
  stubFetch({
    [lab]: { body: community },
    [lemmyuser]: { body: userDocument },
    ...finger('lab', lab, 'Group'),
    ...finger('lemmyuser', lemmyuser, 'Person'),
    ...nodeInfoRoutes('lemmy.test', 'lemmy', '0.19.21'),
    ...extra,
  });

const lookup = (text: string) => parseLookup(text)!;
const urls = (requests: { url: string }[]) => requests.map((request) => request.url);

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance('disc.test');
  forgetNodeInfoFailures();
});

describe('a handle', () => {
  test('finds a community through WebFinger and its own document, stores it, and answers with its local page', async () => {
    const { fetch, requests } = peer();
    const result = await resolveLookup(lookup('!lab@lemmy.test'), { fetch });
    expect(result).toMatchObject({ ok: true, found: { kind: 'community', actor: { apId: lab, handle: 'lab@lemmy.test', local: false } } });
    expect(urls(requests)).toEqual([
      'https://lemmy.test/.well-known/webfinger?resource=acct%3Alab%40lemmy.test',
      lab,
      'https://lemmy.test/.well-known/nodeinfo',
      'https://lemmy.test/nodeinfo/2.1',
    ]);
    expect(await db().select({ kind: actors.kind }).from(actors).where(eq(actors.apId, lab))).toEqual([{ kind: 'Group' }]);
  });

  test('finds a person', async () => {
    const result = await resolveLookup(lookup('@lemmyuser@lemmy.test'), { fetch: peer().fetch });
    expect(result).toMatchObject({ ok: true, found: { kind: 'person', actor: { apId: lemmyuser } } });
  });

  test('names the failure: an unknown handle, a peer that is down or gone, a sigil that is wrong, an address that is not public', async () => {
    const code = async (text: string, extra: Parameters<typeof stubFetch>[0] = {}) => {
      const result = await resolveLookup(lookup(text), { fetch: peer(extra).fetch });
      return result.ok ? 'found' : result.error;
    };
    expect(await code('!nobody@lemmy.test')).toBe('target.not_found');
    expect(await code('!lab@lemmy.test', { [lab]: { status: 410 } })).toBe('target.gone');
    expect(await code('!lab@lemmy.test', { [lab]: { status: 503 } })).toBe('peer.unreachable');
    expect(await code('!lab@lemmy.test', { [lab]: { status: 403 } })).toBe('peer.invalid');
    expect(await code('@lab@lemmy.test', finger('lab', lab, 'Group'))).toBe('peer.invalid');
    const unreachable = await resolveLookup(lookup('!lab@lemmy.test'), {
      fetch: async () => {
        throw new BlockedDestinationError('10.0.0.1 is not a public destination');
      },
    });
    expect(unreachable).toEqual({ ok: false, error: 'input.invalid' });
  });

  test('a deleted person is gone and a Service is a person; an Application is not a person or a community', async () => {
    const service = actorDocument('lemmy.test', 'bot', { publicKeyPem, extra: { type: 'Service' } });
    const app = actorDocument('lemmy.test', 'app', { publicKeyPem, extra: { type: 'Application' } });
    const extra = {
      ...finger('bot', service.id, 'Person'),
      [service.id]: { body: service },
      ...finger('app', app.id, 'Person'),
      [app.id]: { body: app },
    };
    expect(await resolveLookup(lookup('@bot@lemmy.test'), { fetch: peer(extra).fetch })).toMatchObject({
      ok: true,
      found: { kind: 'person' },
    });
    expect(await resolveLookup(lookup(app.id), { fetch: peer(extra).fetch })).toEqual({ ok: false, error: 'object.unsupported' });
    // A handle's sigil cannot name an Application, so the actor's own document disagrees with it.
    expect(await resolveLookup(lookup('@app@lemmy.test'), { fetch: peer(extra).fetch })).toEqual({ ok: false, error: 'peer.invalid' });
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.apId, service.id));
    expect(await resolveLookup(lookup('@bot@lemmy.test'), { fetch: peer(extra).fetch })).toEqual({ ok: false, error: 'target.gone' });
  });

  test('a community an admin removed is stored but not shown', async () => {
    await resolveLookup(lookup('!lab@lemmy.test'), { fetch: peer().fetch });
    const [row] = await db().select().from(actors).where(eq(actors.apId, lab));
    await seedCommunityRemoval(row!);
    expect(await resolveLookup(lookup('!lab@lemmy.test'), { fetch: peer().fetch })).toEqual({ ok: false, error: 'target.removed' });
  });

  test('this server’s own host is never asked about: no request', async () => {
    const { fetch, requests } = peer();
    expect(await resolveLookup(lookup('!nothing@disc.test'), { fetch })).toEqual({ ok: false, error: 'target.not_found' });
    expect(await resolveLookup(lookup('https://disc.test/c/nothing'), { fetch })).toEqual({ ok: false, error: 'target.not_found' });
    expect(requests).toEqual([]);
  });
});

describe('the Group documents Lemmy and PieFed serve', () => {
  test.each([
    ['lemmy', '0.19.21', 'lemmy.lab.test', 'lab', 'wire/lemmy-0.19.21/fetched/fetched-0006-group.json'],
    ['piefed', '1.8.11', 'piefed.lab.test', 'pflab', 'wire/piefed-1.8.11/fetched/fetched-0010-group.json'],
  ])(
    '%s %s: a handle finds the community, and the directory lists it from the stored copy',
    async (software, version, host, name, file) => {
      const document = readFixture(file) as { id: string };
      const peer = stubFetch({
        [document.id]: { body: document },
        [`https://${host}/.well-known/webfinger?resource=acct%3A${name}%40${host}`]: {
          type: 'application/jrd+json',
          body: webfingerAnswer(`acct:${name}@${host}`, [{ href: document.id, type: 'Group' }]),
        },
        ...nodeInfoRoutes(host, software, version),
      });
      const result = await resolveLookup(lookup(`!${name}@${host}`), { fetch: peer.fetch });
      expect(result).toMatchObject({ ok: true, found: { kind: 'community', actor: { apId: document.id, handle: `${name}@${host}` } } });
      const { rows } = await listCommunities(defaultQuery, null);
      expect(rows.map((row) => row.actor.handle)).toEqual([`${name}@${host}`]);
      expect(rows[0]?.refreshedAt).not.toBeNull();
    },
  );
});

describe('a link to an actor', () => {
  test('is read once for what it is, then the actor is resolved at its own id', async () => {
    const { fetch, requests } = peer();
    const result = await resolveLookup(lookup(lab), { fetch });
    expect(result).toMatchObject({ ok: true, found: { kind: 'community', actor: { apId: lab } } });
    expect(urls(requests).filter((request) => request === lab)).toHaveLength(2);
  });

  test('follows a redirect to the document, and an unknown type or a page that is no document is refused', async () => {
    const moved = peer({ 'https://lemmy.test/old/lab': { status: 301, location: lab, body: '' } });
    expect(await resolveLookup(lookup('https://lemmy.test/old/lab'), { fetch: moved.fetch })).toMatchObject({
      ok: true,
      found: { kind: 'community' },
    });
    const odd = peer({ 'https://lemmy.test/thing': { body: { type: 'Event', id: 'https://lemmy.test/thing' } } });
    expect(await resolveLookup(lookup('https://lemmy.test/thing'), { fetch: odd.fetch })).toEqual({
      ok: false,
      error: 'object.unsupported',
    });
    const html = peer({ 'https://lemmy.test/page': { type: 'text/html', body: '<p>hi</p>' } });
    expect(await resolveLookup(lookup('https://lemmy.test/page'), { fetch: html.fetch })).toEqual({ ok: false, error: 'peer.invalid' });
    const none = peer({ 'https://lemmy.test/none': { body: { hello: 'world' } } });
    expect(await resolveLookup(lookup('https://lemmy.test/none'), { fetch: none.fetch })).toEqual({ ok: false, error: 'peer.invalid' });
    expect(await resolveLookup(lookup('https://lemmy.test/missing'), { fetch: peer().fetch })).toEqual({
      ok: false,
      error: 'target.not_found',
    });
  });
});

describe('a link to a post or a comment', () => {
  test('stores a post under the community that serves it, and answers with its local page', async () => {
    const page = lemmyPage(300);
    const { fetch, requests } = peer({ [`${lemmy}/post/300`]: { body: page } });
    const result = await resolveLookup(lookup(`${lemmy}/post/300`), { fetch });
    const [stored] = await db()
      .select()
      .from(posts)
      .where(eq(posts.apId, `${lemmy}/post/300`));
    expect(stored).toMatchObject({ title: 'Post 300', local: false });
    expect(result).toEqual({ ok: true, found: { kind: 'post', postId: stored!.id } });
    expect(urls(requests).filter((request) => request === `${lemmy}/post/300`)).toHaveLength(2);
    // A second lookup of what we hold stores nothing new.
    await resolveLookup(lookup(`${lemmy}/post/300`), { fetch });
    expect(await db().select().from(posts)).toHaveLength(1);
  });

  test('stores a comment with its parent post fetched first', async () => {
    const { fetch } = peer({
      [`${lemmy}/post/310`]: { body: lemmyPage(310) },
      [`${lemmy}/comment/1`]: { body: lemmyNote(1, `${lemmy}/post/310`) },
    });
    const result = await resolveLookup(lookup(`${lemmy}/comment/1`), { fetch });
    const [comment] = await db()
      .select()
      .from(comments)
      .where(eq(comments.apId, `${lemmy}/comment/1`));
    expect(result).toEqual({ ok: true, found: { kind: 'comment', postId: comment!.postId, commentId: comment!.id } });
    expect(await db().select().from(posts)).toHaveLength(1);
  });

  test('stores nothing for an object that is not on its community’s origin', async () => {
    // A rogue server claims lab as its post's community; lab's word is the only vouching.
    const rogue = lemmyPage(1, { id: 'https://rogue.test/post/1', attributedTo: 'https://rogue.test/u/mallory' });
    const { fetch } = peer({ 'https://rogue.test/post/1': { body: rogue }, ...nodeInfoRoutes('rogue.test', 'lemmy') });
    expect(await resolveLookup(lookup('https://rogue.test/post/1'), { fetch })).toEqual({ ok: false, error: 'object.unvouched' });
    expect(await db().select().from(posts)).toEqual([]);
    expect(await db().select({ name: actors.name }).from(actors).where(eq(actors.name, 'mallory'))).toEqual([]);
  });

  test('refuses what the inbox refuses: NSFW content, a comment with no community, an author off its origin', async () => {
    const code = async (id: string, document: unknown) => {
      const result = await resolveLookup(lookup(id), { fetch: peer({ [id]: { body: document } }).fetch });
      return result.ok ? 'found' : result.error;
    };
    expect(await code(`${lemmy}/post/320`, lemmyPage(320, { sensitive: true }))).toBe('content.nsfw_rejected');
    expect(await code(`${lemmy}/post/322`, lemmyPage(322, { attributedTo: 'https://rogue.test/u/mallory' }))).toBe('peer.invalid');
    expect(await code(`${lemmy}/comment/323`, lemmyNote(323, `${lemmy}/post/1`, { audience: undefined }))).toBe('object.unsupported');
    expect(await db().select().from(posts)).toEqual([]);
  });

  test('refuses a post or comment whose author alias redirects to someone else, and stores nothing in their name', async () => {
    // lemmy.test hosts both the community and the alias; the alias redirects to an innocent person on other.test.
    const alias = `${lemmy}/u/alias`;
    const victim = actorDocument('other.test', 'victim', { publicKeyPem });
    const { fetch } = peer({
      [alias]: { status: 302, location: victim.id },
      [victim.id]: { body: victim },
      ...nodeInfoRoutes('other.test', 'lemmy', '0.19.21'),
      [`${lemmy}/post/330`]: { body: lemmyPage(330, { attributedTo: alias }) },
      [`${lemmy}/post/331`]: { body: lemmyPage(331) },
      [`${lemmy}/comment/332`]: { body: lemmyNote(332, `${lemmy}/post/331`, { attributedTo: alias }) },
    });
    expect(await resolveLookup(lookup(`${lemmy}/post/330`), { fetch })).toEqual({ ok: false, error: 'peer.invalid' });
    expect(await resolveLookup(lookup(`${lemmy}/comment/332`), { fetch })).toEqual({ ok: false, error: 'peer.invalid' });
    const [victimRow] = await db().select({ id: actors.id }).from(actors).where(eq(actors.apId, victim.id));
    expect(
      await db()
        .select({ apId: posts.apId })
        .from(posts)
        .where(eq(posts.authorId, victimRow?.id ?? '')),
    ).toEqual([]);
    expect(await db().select({ apId: comments.apId }).from(comments)).toEqual([]);
    expect((await db().select({ apId: posts.apId }).from(posts)).map((row) => row.apId)).toEqual([`${lemmy}/post/331`]);
  });

  test('refuses a post of a community flagged sensitive or nsfl', async () => {
    for (const flag of ['sensitive', 'nsfl']) {
      await truncateAll();
      await seedLocalInstance('disc.test');
      const id = `${lemmy}/post/321`;
      const result = await resolveLookup(lookup(id), {
        fetch: peer({ [id]: { body: lemmyPage(321) } }, labDocument({ [flag]: true })).fetch,
      });
      expect(result, flag).toEqual({ ok: false, error: 'content.nsfw_rejected' });
      expect(await db().select().from(posts)).toEqual([]);
    }
  });

  test('a Tombstone or a 410 is gone, a peer that is down is unreachable', async () => {
    const id = `${lemmy}/post/330`;
    expect(await resolveLookup(lookup(id), { fetch: peer({ [id]: { body: { type: 'Tombstone', id } } }).fetch })).toEqual({
      ok: false,
      error: 'target.gone',
    });
    expect(await resolveLookup(lookup(id), { fetch: peer({ [id]: { status: 410 } }).fetch })).toEqual({ ok: false, error: 'target.gone' });
    expect(await resolveLookup(lookup(id), { fetch: peer({ [id]: { status: 503 } }).fetch })).toEqual({
      ok: false,
      error: 'peer.unreachable',
    });
    const page = lemmyPage(331);
    const down = peer({ [`${lemmy}/post/331`]: { body: page }, [lab]: { status: 503 } });
    expect(await resolveLookup(lookup(`${lemmy}/post/331`), { fetch: down.fetch })).toEqual({ ok: false, error: 'peer.unreachable' });
  });
});

describe('the request allowance', () => {
  test('a lookup that wants a 13th request ends as resolve.too_large, having made 12', async () => {
    // Three redirects to reach the comment, then a chain of parents the comment needs fetched first.
    const chain = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((n) => [
        `${lemmy}/comment/${n}`,
        { body: lemmyNote(n, n === 1 ? `${lemmy}/post/340` : `${lemmy}/comment/${n - 1}`) },
      ]),
    );
    const { fetch, requests } = peer({
      [`${lemmy}/post/340`]: { body: lemmyPage(340) },
      ...chain,
      [`${lemmy}/r/1`]: { status: 301, location: `${lemmy}/r/2`, body: '' },
      [`${lemmy}/r/2`]: { status: 301, location: `${lemmy}/r/3`, body: '' },
      [`${lemmy}/r/3`]: { status: 301, location: `${lemmy}/comment/6`, body: '' },
    });
    expect(await resolveLookup(lookup(`${lemmy}/r/1`), { fetch })).toEqual({ ok: false, error: 'resolve.too_large' });
    expect(requests).toHaveLength(maxRequests);
  });
});

describe('under a visitor’s request', () => {
  test('a peer whose NodeInfo answers 404 is logged without the host the visitor typed; the worker still names it', async () => {
    const { requestScope } = await import('@peblish/core/log-scope');
    const { vi } = await import('vitest');
    const missing = { 'https://lemmy.test/.well-known/nodeinfo': { status: 404 } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await requestScope.run('GET /resolve/', () =>
        resolveLookup(lookup('!lab@lemmy.test'), { fetch: peer(missing).fetch }),
      );
      expect(result).toMatchObject({ ok: true });
      const logged = warn.mock.calls.flat().map(String);
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) {
        expect(line).not.toContain('lemmy.test');
        expect(line).not.toMatch(/[\r\n]/);
      }
      warn.mockClear();
      forgetNodeInfoFailures();
      await truncateAll();
      await seedLocalInstance('disc.test');
      await resolveLookup(lookup('!lab@lemmy.test'), { fetch: peer(missing).fetch });
      expect(warn.mock.calls.flat().map(String).join('\n')).toContain('https://lemmy.test');
    } finally {
      warn.mockRestore();
    }
  });
});
