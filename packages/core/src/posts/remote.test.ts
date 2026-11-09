import type { Principal } from '@peblish/schema/authz';
import { parseEvent } from '@peblish/schema/events';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents } from '../testing/seed-az.ts';
import { seedActor } from '../testing/seed.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { deletePost, restorePost } from './delete.ts';
import { storeRemotePost, updateRemotePost, type RemotePost } from './remote.ts';

beforeEach(truncateAll);

const record = (extra: Partial<RemotePost> = {}): RemotePost => ({
  apId: 'https://lemmy.test/post/1',
  title: 'A post from lemmy',
  url: null,
  urlContentType: null,
  altText: null,
  thumbnailUrl: null,
  bodyMd: null,
  contentHtml: '<p>Hello <b>there</b></p>',
  sensitive: false,
  nsfl: false,
  language: 'en',
  publishedAt: new Date('2026-11-01T10:00:00Z'),
  editedAt: null,
  raw: { type: 'Page', id: 'https://lemmy.test/post/1' },
  ...extra,
});

async function setup() {
  const world = await seedPostWorld();
  const author: Principal = { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null };
  const community = world.communities.remote;
  const create = async (post: RemotePost) => storeRemotePost(await grantFor('post.create', author, { communityId: community.id }), post);
  return { world, author, community, create };
}

const row = async (id: string) => (await db().select().from(posts).where(eq(posts.id, id)))[0]!;

describe('storeRemotePost', () => {
  test("stores a peer's post as its author, sanitising the HTML, with the peer's time and id, and emits post.created as remote", async () => {
    const { world, community, create } = await setup();
    const { id, created } = await create(record({ contentHtml: '<p>Hi <script>alert(1)</script><b>there</b></p>' }));
    expect(created).toBe(true);
    expect(await row(id)).toMatchObject({
      apId: 'https://lemmy.test/post/1',
      local: false,
      instanceId: world.instances.lemmy.id,
      authorId: world.people.remoteAuthor.id,
      communityId: community.id,
      title: 'A post from lemmy',
      bodyMd: null,
      contentHtml: '<p>Hi <b>there</b></p>',
      publishedAt: new Date('2026-11-01T10:00:00Z'),
      language: 'en',
    });
    expect((await row(id)).contentHtml).not.toContain('script');
    expect(await outboxEvents()).toEqual([
      { type: 'post.created', v: 1, postId: id, communityId: community.id, authorId: world.people.remoteAuthor.id, local: false },
    ]);
  });

  test('keeps Markdown source and renders it for this instance; uses the receive time when the peer sent none', async () => {
    const { create } = await setup();
    const before = Date.now();
    const { id } = await create(record({ bodyMd: 'see [home](/c/open)', contentHtml: '<p>ignored</p>', publishedAt: null }));
    const stored = await row(id);
    expect(stored.bodyMd).toBe('see [home](/c/open)');
    expect(stored.contentHtml).toContain('href="https://feddit.test/c/open"');
    expect(stored.contentHtml).not.toContain('ignored');
    expect(stored.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('a redelivered Create changes nothing and emits nothing; the first copy stays', async () => {
    const { create } = await setup();
    const first = await create(record());
    expect(await create(record({ title: 'Different title' }))).toEqual({ id: first.id, created: false });
    expect((await row(first.id)).title).toBe('A post from lemmy');
    expect(await outboxEvents()).toHaveLength(1);
  });

  test('an id that is already stored under another author or community is refused, and reads nothing of the stored post', async () => {
    const { world, community, create } = await setup();
    const first = await create(record());
    const other = await seedActor(world.instances.lemmy, 'Person', 'someone_else');
    const byOther = await grantFor('post.create', { kind: 'remote', actorId: other.id, announcedBy: null }, { communityId: community.id });
    await expect(storeRemotePost(byOther, record())).rejects.toMatchObject({ name: 'Refused', reason: 'post.id_conflict' });
    const elsewhere = await grantFor(
      'post.create',
      { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null },
      { communityId: world.communities.remoteRestricted.id },
    );
    await expect(storeRemotePost(elsewhere, record())).rejects.toMatchObject({ name: 'Refused', reason: 'post.id_conflict' });
    expect(await db().select({ id: posts.id }).from(posts).where(eq(posts.apId, record().apId))).toEqual([{ id: first.id }]);
    expect(await outboxEvents()).toHaveLength(1);
  });

  test("a peer's link, preview, media type and alt text are held to the limits a local post gets; what fails is null", async () => {
    const { create } = await setup();
    const bad = await create(
      record({
        url: `https://example.test/${'x'.repeat(2_000)}`,
        thumbnailUrl: 'javascript:alert(1)',
        urlContentType: 'not a media type',
        altText: 'x'.repeat(1_001),
      }),
    );
    expect(await row(bad.id)).toMatchObject({ url: null, thumbnailUrl: null, urlContentType: null, altText: null });
    const good = await create(
      record({
        apId: 'https://lemmy.test/post/2',
        url: 'https://example.test/a.png',
        thumbnailUrl: 'https://example.test/a.png?w=100',
        urlContentType: 'image/*',
        altText: 'A picture',
      }),
    );
    expect(await row(good.id)).toMatchObject({
      url: 'https://example.test/a.png',
      thumbnailUrl: 'https://example.test/a.png?w=100',
      urlContentType: 'image/*',
      altText: 'A picture',
    });
  });

  test("a peer's language is kept as a plausible BCP 47 tag with a lowercase primary subtag; an oversized or malformed one is null", async () => {
    const { author, create } = await setup();
    const created = await create(record({ language: 'PT-BR' }));
    expect((await row(created.id)).language).toBe('pt-BR');
    const grant = await grantFor('post.update', author, { postId: created.id });
    const languageAfter = async (language: string) => {
      await updateRemotePost(grant, record({ language }));
      return (await row(created.id)).language;
    };
    expect(await languageAfter('zh-Hant-TW')).toBe('zh-Hant-TW');
    expect(await languageAfter(`en-${'a'.repeat(33)}`)).toBeNull();
    expect(await languageAfter('en-US')).toBe('en-US');
    for (const malformed of [
      '',
      'e',
      'english',
      'en_US',
      'en--US',
      'en-',
      'en-x',
      'not a language',
      '<script>',
      'en-US\n',
      `${'a'.repeat(36)}`,
    ]) {
      expect(await languageAfter(malformed), malformed).toBeNull();
      await languageAfter('en');
    }
    const oversized = await create(record({ apId: 'https://lemmy.test/post/2', language: `en-${'a'.repeat(40)}` }));
    expect((await row(oversized.id)).language).toBeNull();
    // The longest accepted tag is 35 characters; one more is null though its shape is fine.
    const longest = `en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(5)}`;
    expect(longest).toHaveLength(35);
    expect(await languageAfter(longest)).toBe(longest);
    expect(await languageAfter(`${longest}e`)).toBeNull();
  });

  test('the author cannot lock or pin their own post through the document', async () => {
    const { create } = await setup();
    // A PostRecord's locked and featuredCommunity are not read: only AZ's lock and pin mutations set them.
    const { id } = await create({ ...record(), locked: true, featuredCommunity: true } as RemotePost);
    expect(await row(id)).toMatchObject({ locked: false, featuredCommunity: false });
  });

  test('refuses a local principal, a title that is too long is cut, and sensitive follows the community and NSFL', async () => {
    const { world, community, create } = await setup();
    const reader: Principal = { kind: 'local', actorId: world.people.reader.id, siteRole: 'user' };
    await expect(
      storeRemotePost(await grantFor('post.create', reader, { communityId: world.communities.open.id }), record()),
    ).rejects.toThrow(TypeError);
    const long = await create(record({ title: `${'x'.repeat(600)}\n`, nsfl: true }));
    const stored = await row(long.id);
    expect([...stored.title]).toHaveLength(500);
    expect(stored).toMatchObject({ nsfl: true, sensitive: true, communityId: community.id });
  });
});

describe("updateRemotePost, and the author's delete and undo", () => {
  test('replaces the editable fields, keeps published and the counts, and emits post.updated as remote', async () => {
    const { world, author, create } = await setup();
    const { id } = await create(record());
    const edited = new Date('2026-11-02T00:00:00Z');
    const result = await updateRemotePost(
      await grantFor('post.update', author, { postId: id }),
      record({ title: 'Edited title', bodyMd: 'new **body**', url: 'https://example.test/x', editedAt: edited }),
    );
    expect(result).toEqual({ id });
    const stored = await row(id);
    expect(stored).toMatchObject({
      title: 'Edited title',
      bodyMd: 'new **body**',
      url: 'https://example.test/x',
      editedAt: edited,
      publishedAt: new Date('2026-11-01T10:00:00Z'),
    });
    expect(stored.contentHtml).toContain('<strong>body</strong>');
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'post.updated',
      v: 1,
      postId: id,
      communityId: world.communities.remote.id,
      authorId: world.people.remoteAuthor.id,
      local: false,
    });
  });

  test('a redelivered Update (direct, then announced) changes nothing: no write, no second event, the edit time stays', async () => {
    const { author, create } = await setup();
    const { id } = await create(record());
    const update = async (post: RemotePost) => updateRemotePost(await grantFor('post.update', author, { postId: id }), post);
    // Nothing the peer sends differs from what is stored: not an edit.
    await update(record());
    expect((await row(id)).editedAt).toBeNull();
    // A real change without `updated` takes the receive time, once.
    await update(record({ title: 'Edited title' }));
    const stamped = (await row(id)).editedAt;
    expect(stamped).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await update(record({ title: 'Edited title' }));
    await update(record({ title: 'Edited title', raw: { type: 'Page', announced: true } }));
    expect((await row(id)).editedAt).toEqual(stamped);
    expect((await outboxEvents()).map((event) => parseEvent(event).type)).toEqual(['post.created', 'post.updated']);
  });

  test('an Update that only changes who is mentioned is an edit: the tags are stored and post.updated goes out, once', async () => {
    const { author, create } = await setup();
    const { id } = await create(record());
    const update = async (post: RemotePost) => updateRemotePost(await grantFor('post.update', author, { postId: id }), post);
    const mention = { type: 'Mention', href: 'https://lemmy.test/u/reader', name: '@reader@lemmy.test' };
    const tagged = { type: 'Page', id: 'https://lemmy.test/post/1', tag: [mention] };
    await update(record({ raw: tagged }));
    expect((await row(id)).raw).toEqual(tagged);
    // The same tags again, repeated, change nothing.
    await update(record({ raw: { ...tagged, tag: [mention, mention] } }));
    expect((await outboxEvents()).map((event) => parseEvent(event).type)).toEqual(['post.created', 'post.updated']);
  });

  test("the peer's own `updated` is kept as sent, a redelivery of it is a no-op, and an older Update arriving later is ignored", async () => {
    const { author, create } = await setup();
    const { id } = await create(record());
    const update = async (post: RemotePost) => updateRemotePost(await grantFor('post.update', author, { postId: id }), post);
    const second = new Date('2026-11-03T00:00:00Z');
    await update(record({ title: 'Second edit', editedAt: second }));
    await update(record({ title: 'Second edit', editedAt: second }));
    expect(await row(id)).toMatchObject({ title: 'Second edit', editedAt: second });
    // The first edit, delivered after the second: not applied, not an event, the edit time stays.
    await update(record({ title: 'First edit', editedAt: new Date('2026-11-02T00:00:00Z') }));
    expect(await row(id)).toMatchObject({ title: 'Second edit', editedAt: second });
    // A later edit still applies.
    const third = new Date('2026-11-04T00:00:00Z');
    await update(record({ title: 'Third edit', editedAt: third }));
    expect(await row(id)).toMatchObject({ title: 'Third edit', editedAt: third });
    expect((await outboxEvents()).map((event) => parseEvent(event).type)).toEqual(['post.created', 'post.updated', 'post.updated']);
  });

  test('locked and featuredCommunity on a mapped record are ignored on update; the stored flags stay', async () => {
    const { author, create } = await setup();
    const { id } = await create(record());
    await writer().update(posts).set({ locked: true, featuredCommunity: true }).where(eq(posts.id, id));
    const grant = await grantFor('post.update', author, { postId: id });
    await updateRemotePost(grant, { ...record({ title: 'Edited title' }), locked: false, featuredCommunity: false } as RemotePost);
    expect(await row(id)).toMatchObject({ title: 'Edited title', locked: true, featuredCommunity: true });
    await updateRemotePost(grant, { ...record({ title: 'Edited again' }), locked: true, featuredCommunity: true } as RemotePost);
    expect(await row(id)).toMatchObject({ title: 'Edited again', locked: true, featuredCommunity: true });
  });

  test('an Update is held to the same limits as a Create', async () => {
    const { author, create } = await setup();
    const { id } = await create(record({ url: 'https://example.test/a', urlContentType: 'text/html' }));
    await updateRemotePost(
      await grantFor('post.update', author, { postId: id }),
      record({ url: 'ftp://example.test/a', urlContentType: 'x'.repeat(256), thumbnailUrl: `https://example.test/${'x'.repeat(2_000)}` }),
    );
    expect(await row(id)).toMatchObject({ url: null, urlContentType: null, thumbnailUrl: null });
  });

  test('refuses an update by anyone but the author', async () => {
    const { world, create } = await setup();
    const { id } = await create(record());
    const reader: Principal = { kind: 'local', actorId: world.people.reader.id, siteRole: 'user' };
    expect(await authorize('post.update', reader, { postId: id })).toEqual({ ok: false, reason: 'post.author_required' });
  });

  test('a record under another object id is refused post.id_conflict: the post is unchanged and no event is emitted', async () => {
    const { author, create } = await setup();
    const { id } = await create(record());
    const before = await row(id);
    await expect(
      updateRemotePost(
        await grantFor('post.update', author, { postId: id }),
        record({ apId: 'https://lemmy.test/post/2', title: 'Taken over' }),
      ),
    ).rejects.toMatchObject({ name: 'Refused', action: 'post.update', reason: 'post.id_conflict' });
    expect(await row(id)).toEqual(before);
    expect((await outboxEvents()).map((event) => parseEvent(event).type)).toEqual(['post.created']);
  });

  test('Delete and Undo(Delete) by the remote author are the same soft delete and restore, emitted as remote', async () => {
    const { world, author, create } = await setup();
    const { id } = await create(record());
    await deletePost(await grantFor('post.delete', author, { postId: id }));
    expect((await row(id)).deletedAt).toBeInstanceOf(Date);
    await restorePost(await grantFor('post.restore', author, { postId: id }));
    expect((await row(id)).deletedAt).toBeNull();
    const base = { v: 1, postId: id, communityId: world.communities.remote.id, authorId: world.people.remoteAuthor.id, local: false };
    expect((await outboxEvents()).slice(1)).toEqual([
      { type: 'post.deleted', ...base },
      { type: 'post.restored', ...base },
    ]);
  });
});
