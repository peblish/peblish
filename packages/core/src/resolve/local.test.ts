import { beforeEach, describe, expect, test } from 'vitest';
import { truncateAll } from '../testing/db';
import { seedActor, seedInstance } from '../testing/seed';
import { seedComment, seedCommunityRemoval, seedPost } from '../testing/seed-az';
import { seedLocalInstance } from '../testing/seed-fed-a';
import { findHeld, pointsHere } from './local.ts';
import type { Lookup } from './outcome.ts';
import { parseLookup } from './parse.ts';

const lookup = (text: string): Lookup => {
  const parsed = parseLookup(text);
  if (!parsed) throw new Error(`not a lookup: ${text}`);
  return parsed;
};

// The local instance is `held.test`; its peer is `lemmy.test`.
let world: Awaited<ReturnType<typeof seed>>;
async function seed() {
  const { instance: here } = await seedLocalInstance('held.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const lab = await seedActor(lemmy, 'Group', 'Lab', { apId: 'https://lemmy.test/c/Lab' });
  const mira = await seedActor(lemmy, 'Person', 'mira', { apId: 'https://lemmy.test/u/mira' });
  const news = await seedActor(here, 'Group', 'news', { apId: 'https://held.test/c/news' });
  const alice = await seedActor(here, 'Person', 'alice', { apId: 'https://held.test/u/alice' });
  const post = await seedPost(lemmy, lab, mira, { apId: 'https://lemmy.test/post/7' });
  const comment = await seedComment(lemmy, post, mira, { apId: 'https://lemmy.test/comment/9' });
  const localPost = await seedPost(here, news, alice);
  return { here, lemmy, lab, mira, news, alice, post, comment, localPost };
}
beforeEach(async () => {
  await truncateAll();
  world = await seed();
});

describe('a handle', () => {
  test('finds a remote community or person by host and name, case aside, with the sigil choosing the kind', async () => {
    expect(await findHeld(lookup('!lab@LEMMY.test'))).toMatchObject({
      kind: 'community',
      actor: { id: world.lab.id, handle: 'Lab@lemmy.test' },
    });
    expect(await findHeld(lookup('@MIRA@lemmy.test'))).toMatchObject({ kind: 'person', actor: { id: world.mira.id } });
    expect(await findHeld(lookup('@lab@lemmy.test'))).toBeNull();
    expect(await findHeld(lookup('!mira@lemmy.test'))).toBeNull();
    expect(await findHeld(lookup('lab@lemmy.test'))).toMatchObject({ kind: 'community' });
  });

  test('a name shared by a community and a person answers each its own sigil, and the community without one', async () => {
    const twin = await seedActor(world.lemmy, 'Person', 'lab', { apId: 'https://lemmy.test/u/lab' });
    expect(await findHeld(lookup('@lab@lemmy.test'))).toMatchObject({ kind: 'person', actor: { id: twin.id } });
    expect(await findHeld(lookup('!lab@lemmy.test'))).toMatchObject({ kind: 'community', actor: { id: world.lab.id } });
    expect(await findHeld(lookup('lab@lemmy.test'))).toMatchObject({ kind: 'community', actor: { id: world.lab.id } });
  });

  test('this server’s own host is the local actor, held or not', async () => {
    expect(await findHeld(lookup('!news@held.test'))).toMatchObject({ kind: 'community', actor: { id: world.news.id, handle: 'news' } });
    expect(await findHeld(lookup('@alice@held.test'))).toMatchObject({ kind: 'person', actor: { id: world.alice.id } });
    expect(await findHeld(lookup('!nothing@held.test'))).toBeNull();
    expect(await pointsHere(lookup('!nothing@held.test'))).toBe(true);
    expect(await pointsHere(lookup('!lab@lemmy.test'))).toBe(false);
  });

  test('a deleted or removed community, and a deleted person, are not held', async () => {
    const { writer } = await import('../db/write.ts');
    const { actors } = await import('../db/tables/actors.ts');
    const { eq } = await import('drizzle-orm');
    await seedCommunityRemoval(world.lab);
    expect(await findHeld(lookup('!lab@lemmy.test'))).toBeNull();
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, world.mira.id));
    expect(await findHeld(lookup('@mira@lemmy.test'))).toBeNull();
  });
});

describe('a link', () => {
  test('finds an actor, a post and a comment by their ActivityPub ids, with or without a trailing slash or fragment', async () => {
    expect(await findHeld(lookup('https://lemmy.test/c/Lab'))).toMatchObject({ kind: 'community', actor: { id: world.lab.id } });
    expect(await findHeld(lookup('https://lemmy.test/c/Lab/'))).toMatchObject({ kind: 'community' });
    expect(await findHeld(lookup('https://lemmy.test/u/mira#top'))).toMatchObject({ kind: 'person' });
    expect(await findHeld(lookup('https://lemmy.test/post/7'))).toEqual({ kind: 'post', postId: world.post.id });
    expect(await findHeld(lookup('https://lemmy.test/comment/9'))).toEqual({
      kind: 'comment',
      postId: world.post.id,
      commentId: world.comment.id,
    });
    expect(await findHeld(lookup('https://lemmy.test/post/8'))).toBeNull();
  });

  test('finds this server’s own pages by their paths, a remote community’s page by its handle', async () => {
    expect(await findHeld(lookup('https://held.test/c/NEWS'))).toMatchObject({ kind: 'community', actor: { id: world.news.id } });
    expect(await findHeld(lookup('https://held.test/u/alice'))).toMatchObject({ kind: 'person' });
    expect(await findHeld(lookup(`https://held.test/post/${world.localPost.id}`))).toEqual({ kind: 'post', postId: world.localPost.id });
    expect(await findHeld(lookup(`https://held.test/post/${world.post.id}/comments/${world.comment.id}`))).toEqual({
      kind: 'comment',
      postId: world.post.id,
      commentId: world.comment.id,
    });
    expect(await findHeld(lookup('https://held.test/c/Lab@lemmy.test'))).toMatchObject({ kind: 'community', actor: { id: world.lab.id } });
    // A comment under another post is not found through that post's path.
    expect(await findHeld(lookup(`https://held.test/post/${world.localPost.id}/comments/${world.comment.id}`))).toBeNull();
  });

  test('an address on this server that matches nothing is held by nobody and points here', async () => {
    for (const url of [
      'https://held.test/c/missing',
      'https://held.test/post/not-a-uuid',
      'https://held.test/some/page',
      'https://held.test/c/a/b/c',
    ]) {
      expect(await findHeld(lookup(url))).toBeNull();
      expect(await pointsHere(lookup(url))).toBe(true);
    }
    expect(await pointsHere(lookup('https://lemmy.test/c/missing'))).toBe(false);
  });

  test('a deleted or removed post or comment, and one in a removed community, are not held', async () => {
    const { writer } = await import('../db/write.ts');
    const { comments, posts } = await import('../db/tables/content.ts');
    const { eq } = await import('drizzle-orm');
    await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, world.comment.id));
    expect(await findHeld(lookup('https://lemmy.test/comment/9'))).toBeNull();
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, world.post.id));
    expect(await findHeld(lookup('https://lemmy.test/post/7'))).toBeNull();
    const second = await seedPost(world.lemmy, world.lab, world.mira, { apId: 'https://lemmy.test/post/8' });
    expect(await findHeld(lookup('https://lemmy.test/post/8'))).toEqual({ kind: 'post', postId: second.id });
    await seedCommunityRemoval(world.lab);
    expect(await findHeld(lookup('https://lemmy.test/post/8'))).toBeNull();
  });
});
