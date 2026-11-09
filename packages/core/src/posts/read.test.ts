import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedModerator, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedPostWorld } from '../testing/seed-b1.ts';
import { seedActor } from '../testing/seed.ts';
import { feedPredicates } from '../registry/feed-predicates.gen.ts';
import { feedPredicate } from './feed-predicate.ts';
import { postViews, readPost, type Viewer } from './read.ts';

beforeEach(truncateAll);

const user = (person: { id: string }): Viewer => ({ actorId: person.id, siteRole: 'user' });

/** The world, and a few posts in `open` whose text must never reach a viewer who may not see it. */
async function setup() {
  const world = await seedPostWorld();
  const { local } = world.instances;
  const secret = 'SECRET-TEXT';
  const body = async (extra: Partial<typeof posts.$inferInsert>) =>
    seedPost(local, world.communities.open, world.people.author, {
      title: `${secret} title`,
      url: `https://example.test/${secret}`,
      thumbnailUrl: `https://example.test/${secret}.png`,
      bodyMd: `${secret} body`,
      contentHtml: `<p>${secret} body</p>`,
      ...extra,
    });
  return { world, secret, plain: await body({}), sensitive: await body({ sensitive: true }), nsfl: await body({ nsfl: true }) };
}

const withheld = (view: {
  title: string;
  url: string | null;
  thumbnailUrl: string | null;
  excerpt: string | null;
  contentHtml: string | null;
}) => ({
  title: view.title,
  url: view.url,
  thumbnailUrl: view.thumbnailUrl,
  excerpt: view.excerpt,
  contentHtml: view.contentHtml,
});

describe('the post view', () => {
  test("maps a post: counts, handles, badges, the viewer's vote, the excerpt and the edit time", async () => {
    const { world, plain } = await setup();
    await writer().update(actors).set({ displayName: 'The Author' }).where(eq(actors.id, world.people.author.id));
    await seedModerator(world.communities.open, world.people.author);
    const remotePost = await seedPost(world.instances.lemmy, world.communities.remote, world.people.remoteAuthor, {
      bodyMd: null,
      contentHtml: '<p>From <b>lemmy</b></p>',
      editedAt: new Date('2026-11-01T00:00:00Z'),
      upvotes: 3,
      downvotes: 1,
      commentCount: 7,
    });
    const rows = await db().select().from(posts).where(eq(posts.communityId, world.communities.open.id));
    const [view] = await postViews(
      rows.filter((row) => row.id === plain.id),
      null,
    );
    expect(view).toMatchObject({
      id: plain.id,
      apId: plain.apId,
      author: { name: 'author', displayName: 'The Author', local: true, handle: 'author' },
      authorBadge: 'moderator',
      community: { name: 'open', handle: 'open' },
      excerpt: 'SECRET-TEXT body',
      contentHtml: null,
      editedAt: null,
      myVote: 0,
      counts: { upvotes: 0, downvotes: 0, comments: 0 },
    });
    const [remote] = await postViews([remotePost], user(world.people.reader));
    expect(remote).toMatchObject({
      author: { handle: 'remote_author@lemmy.test', local: false },
      community: { handle: 'technology@lemmy.test' },
      authorBadge: null,
      excerpt: 'From lemmy',
      editedAt: '2026-11-01T00:00:00.000Z',
      counts: { upvotes: 3, downvotes: 1, comments: 7 },
    });
  });

  test('the admin badge needs two-factor, like the admin role', async () => {
    const { world } = await setup();
    const post = await seedPost(world.instances.local, world.communities.open, world.people.admin);
    expect((await postViews([post], null))[0]?.authorBadge).toBe('admin');
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, world.people.admin.userId!));
    expect((await postViews([post], null))[0]?.authorBadge).toBeNull();
  });

  test('a deleted post is a readable tombstone: flags kept, content withheld, no body to render', async () => {
    const { world, secret, plain } = await setup();
    await writer().update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, plain.id));
    for (const viewer of [
      null,
      user(world.people.reader),
      user(world.people.author),
      { actorId: world.people.admin.id, siteRole: 'admin' as const },
    ]) {
      const page = await readPost(plain.id, viewer);
      expect(page?.view).toMatchObject({
        deleted: true,
        removed: false,
        title: '',
        url: null,
        thumbnailUrl: null,
        excerpt: null,
        contentHtml: null,
      });
      expect(page?.body).toBeNull();
      expect(JSON.stringify(page)).not.toContain(secret);
    }
  });

  test('a removed post shows only that to everyone but its moderators and site admins', async () => {
    const { world, secret, plain } = await setup();
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, plain.id));
    for (const viewer of [null, user(world.people.reader), user(world.people.author)]) {
      const page = await readPost(plain.id, viewer);
      expect(page).toMatchObject({ view: { removed: true, deleted: false, title: '' }, body: null, moderator: false });
      expect(JSON.stringify(page)).not.toContain(secret);
    }
    for (const viewer of [
      user(world.people.moderator),
      user(world.people.owner),
      { actorId: world.people.admin.id, siteRole: 'admin' as const },
    ]) {
      const page = await readPost(plain.id, viewer);
      expect(page).toMatchObject({
        view: { removed: true, title: `${secret} title` },
        body: { kind: 'markdown', source: `${secret} body` },
        moderator: true,
      });
    }
  });

  test('a missing post, a bad id and a post in a deleted or removed community are not found', async () => {
    const { world, plain } = await setup();
    expect(await readPost('0192f5a0-1234-7abc-8def-0123456789ab', null)).toBeNull();
    expect(await readPost('not-a-uuid', null)).toBeNull();
    expect(await readPost(world.posts.local['community removed'], null)).toBeNull();
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, world.communities.open.id));
    expect(await readPost(plain.id, null)).toBeNull();
  });

  test('a post in a removed or deleted community reaches no viewer through a feed either, moderators and admins included', async () => {
    const { world, secret, plain } = await setup();
    const gone = await seedActor(world.instances.local, 'Group', 'gone');
    const inDeleted = await seedPost(world.instances.local, gone, world.people.author, { title: `${secret} title` });
    const inRemoved = world.posts.local['community removed'];
    const everyone = [
      null,
      user(world.people.reader),
      user(world.people.moderator),
      { actorId: world.people.admin.id, siteRole: 'admin' as const },
    ];
    const feed = async (viewer: Viewer) => (await postViews(await db().select().from(posts), viewer)).map(({ id }) => id);
    for (const viewer of everyone) {
      // The community is still live: the post is in the feed. The removed community's never is.
      expect(await feed(viewer)).toContain(inDeleted.id);
    }
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, gone.id));
    for (const viewer of everyone) {
      const ids = await feed(viewer);
      expect(ids).toContain(plain.id);
      expect(ids).not.toContain(inRemoved);
      expect(ids).not.toContain(inDeleted.id);
      expect(await readPost(inRemoved, viewer)).toBeNull();
      expect(await readPost(inDeleted.id, viewer)).toBeNull();
    }
  });
});

describe('the sensitive-content gate', () => {
  test('a signed-out viewer gets none of a sensitive, NSFL or sensitive-community post', async () => {
    const { world, secret, plain, sensitive, nsfl } = await setup();
    const inSensitiveCommunity = await seedPost(world.instances.local, world.communities.restricted, world.people.author, {
      title: `${secret} title`,
      bodyMd: `${secret} body`,
    });
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, world.communities.restricted.id));
    for (const post of [sensitive, nsfl, inSensitiveCommunity]) {
      const page = await readPost(post.id, null);
      expect(page).toMatchObject({ gate: 'sign-in', body: null });
      expect(withheld(page!.view)).toEqual({ title: '', url: null, thumbnailUrl: null, excerpt: null, contentHtml: null });
      expect(JSON.stringify(page)).not.toContain(secret);
    }
    expect(await readPost(plain.id, null)).toMatchObject({ gate: 'none', view: { title: `${secret} title` } });
    expect((await readPost(sensitive.id, null))?.view).toMatchObject({ sensitive: true });
    expect((await readPost(nsfl.id, null))?.view).toMatchObject({ nsfl: true });
  });

  test('a signed-in viewer without a 16+ declaration gets none of it either', async () => {
    const { world, secret, sensitive } = await setup();
    const page = await readPost(sensitive.id, user(world.people.reader));
    expect(page).toMatchObject({ gate: 'age', body: null });
    expect(JSON.stringify(page)).not.toContain(secret);
  });

  test('a declared viewer gets the content, to be shown blurred behind "show"', async () => {
    const { world, secret, sensitive } = await setup();
    await declareAge(world.people.reader);
    const page = await readPost(sensitive.id, user(world.people.reader));
    expect(page).toMatchObject({
      gate: 'blur',
      view: { title: `${secret} title`, url: `https://example.test/${secret}` },
      body: { kind: 'markdown' },
    });
  });

  test('postViews applies the gate to every row, so a list that forgot the predicate still withholds', async () => {
    const { world, secret, plain, sensitive } = await setup();
    const rows = await db().select().from(posts).where(eq(posts.communityId, world.communities.open.id));
    const views = await postViews(
      rows.filter((row) => [plain.id, sensitive.id].includes(row.id)),
      null,
    );
    expect(views.find((view) => view.id === sensitive.id)).toMatchObject({ title: '', url: null, excerpt: null, sensitive: true });
    expect(views.find((view) => view.id === plain.id)?.title).toBe(`${secret} title`);
  });
});

describe('the feed predicate', () => {
  async function listed(viewer: Viewer) {
    const rows = await db().select({ id: posts.id }).from(posts).where(feedPredicate.where(viewer));
    return new Set(rows.map((row) => row.id));
  }

  test('hides sensitive, NSFL and sensitive-community posts from signed-out and undeclared viewers, and shows them once declared', async () => {
    const { world, plain, sensitive, nsfl } = await setup();
    const inSensitiveCommunity = await seedPost(world.instances.local, world.communities.restricted, world.people.author);
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, world.communities.restricted.id));
    const gated = [sensitive.id, nsfl.id, inSensitiveCommunity.id];

    const signedOut = await listed(null);
    expect(signedOut.has(plain.id)).toBe(true);
    expect(gated.filter((id) => signedOut.has(id))).toEqual([]);
    // Another viewer's declaration does not count.
    await declareAge(world.people.author);
    const undeclared = await listed(user(world.people.reader));
    expect(undeclared.has(plain.id)).toBe(true);
    expect(gated.filter((id) => undeclared.has(id))).toEqual([]);

    await declareAge(world.people.reader);
    const declared = await listed(user(world.people.reader));
    expect(gated.filter((id) => !declared.has(id))).toEqual([]);
  });

  test('is registered by glob, where lane C1 finds it', () => {
    expect(feedPredicates.map(({ name }) => name)).toContain('nsfw-gate');
  });
});
