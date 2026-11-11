import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { seedCommunityRemoval, seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedAccount } from '../testing/seed-b1.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { contentShown } from './reference.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const author = await seedAccount(local, 'author');
  const reader = await seedAccount(local, 'reader');
  await declareAge(reader);
  const community = await seedActor(local, 'Group', 'pics');
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, author);
  return { local, author, reader, community, post, comment, viewer: { actorId: reader.id, siteRole: 'user' as const } };
}

test('a post, comment or profile image stops being shown once its content is removed or deleted', async () => {
  const w = await world();
  const shown = () =>
    Promise.all([
      contentShown({ kind: 'post', id: w.post.id }, w.viewer),
      contentShown({ kind: 'comment', id: w.comment.id }, w.viewer),
      contentShown({ kind: 'actor', id: w.author.id }, w.viewer),
      contentShown({ kind: 'actor', id: w.community.id }, w.viewer),
    ]);
  expect(await shown()).toEqual([true, true, true, true]);

  await writer().update(comments).set({ removedAt: new Date() }).where(eq(comments.id, w.comment.id));
  expect(await shown()).toEqual([true, false, true, true]);
  await writer().update(comments).set({ removedAt: null, deletedAt: new Date() }).where(eq(comments.id, w.comment.id));
  expect(await shown()).toEqual([true, false, true, true]);
  await writer().update(comments).set({ deletedAt: null }).where(eq(comments.id, w.comment.id));

  // A removed post takes its comments' images with it; a deleted one is a tombstone whose comments stay.
  await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, w.post.id));
  expect(await shown()).toEqual([false, false, true, true]);
  await writer().update(posts).set({ removedAt: null, deletedAt: new Date() }).where(eq(posts.id, w.post.id));
  expect(await shown()).toEqual([false, true, true, true]);
  await writer().update(posts).set({ deletedAt: null }).where(eq(posts.id, w.post.id));

  await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.author.id));
  expect(await shown()).toEqual([true, true, false, true]);

  // A removed community takes everything in it, for every viewer.
  await seedCommunityRemoval(w.community);
  expect(await shown()).toEqual([false, false, false, false]);
});

test('an image of sensitive content loads for a signed-in viewer with a 16+ declaration, whatever their Hide NSFW choice (CN3)', async () => {
  const w = await world();
  await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, w.community.id));
  const ask = (viewer: typeof w.viewer | null) =>
    Promise.all([
      contentShown({ kind: 'post', id: w.post.id }, viewer),
      contentShown({ kind: 'comment', id: w.comment.id }, viewer),
      contentShown({ kind: 'actor', id: w.community.id }, viewer),
    ]);
  // Signed out, and signed in without a declaration: the sign-in and age gates hold.
  expect(await ask(null)).toEqual([false, false, false]);
  expect(await ask({ actorId: w.author.id, siteRole: 'user' })).toEqual([false, false, false]);
  // Declared: the proxy reads no Hide NSFW choice (the default hides), so a revealed card's picture loads.
  expect(await ask(w.viewer)).toEqual([true, true, true]);
  // A takedown still stops it.
  await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, w.post.id));
  expect(await ask(w.viewer)).toEqual([false, false, true]);
});

test('an unknown id, or an actor that is neither a person nor a community, is never shown', async () => {
  const w = await world();
  const missing = '0195f0a0-0000-7000-8000-000000000000';
  const instanceActor = await seedActor(w.local, 'Application', 'instance');
  for (const kind of ['post', 'comment', 'actor'] as const) expect(await contentShown({ kind, id: missing }, w.viewer), kind).toBe(false);
  expect(await contentShown({ kind: 'actor', id: instanceActor.id }, w.viewer)).toBe(false);
});
