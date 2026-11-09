import type { Principal } from '@peblish/schema/authz';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents } from '../testing/seed-az.ts';
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

  test('refuses an update by anyone but the author, and a record for another post', async () => {
    const { world, author, create } = await setup();
    const { id } = await create(record());
    const reader: Principal = { kind: 'local', actorId: world.people.reader.id, siteRole: 'user' };
    expect(await authorize('post.update', reader, { postId: id })).toEqual({ ok: false, reason: 'post.author_required' });
    await expect(
      updateRemotePost(await grantFor('post.update', author, { postId: id }), record({ apId: 'https://lemmy.test/post/2' })),
    ).rejects.toThrow(TypeError);
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
