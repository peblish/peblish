import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import type { MediaContent } from '../media/proxy-url.ts';
import { contentShown } from '../media/reference.ts';
import { truncateAll } from '../testing/db.ts';
import { seedCommunityRemoval, seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedAccount } from '../testing/seed-b1.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { publicTags } from './public.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const author = await seedAccount(local, 'author');
  const replier = await seedAccount(local, 'replier');
  await declareAge(replier);
  const community = await seedActor(local, 'Group', 'pics');
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, replier);
  const items: Pick<MediaContent, 'kind' | 'id'>[] = [
    { kind: 'post', id: post.id },
    { kind: 'comment', id: comment.id },
    { kind: 'actor', id: author.id },
    { kind: 'actor', id: community.id },
  ];
  return { local, author, replier, community, post, comment, items };
}

/** Public exactly when the proxy would show it to a signed-out visitor, item by item. */
async function expectPublicIsSignedOut(items: Pick<MediaContent, 'kind' | 'id'>[], expected: boolean[]) {
  const tags = await Promise.all(items.map((item) => publicTags(item)));
  const shown = await Promise.all(items.map((item) => contentShown(item, null)));
  expect(tags.map((t) => t !== null)).toEqual(expected);
  expect(shown).toEqual(expected);
}

test('public content carries the wide tag, its own, and the tags of everything its visibility rests on', async () => {
  const w = await world();
  const [post, comment, person, community] = await Promise.all(w.items.map((item) => publicTags(item)));
  expect(post).toEqual(['pbm', `pbm-p-${w.post.id}`, `pbm-a-${w.community.id}`, `pbm-a-${w.author.id}`]);
  expect(comment).toEqual([
    'pbm',
    `pbm-c-${w.comment.id}`,
    `pbm-p-${w.post.id}`,
    `pbm-a-${w.community.id}`,
    `pbm-a-${w.author.id}`,
    `pbm-a-${w.replier.id}`,
  ]);
  expect(person).toEqual(['pbm', `pbm-a-${w.author.id}`]);
  expect(community).toEqual(['pbm', `pbm-a-${w.community.id}`]);
});

test('content gated, removed or deleted for a signed-out visitor is never public, whoever else may see it', async () => {
  const w = await world();
  await expectPublicIsSignedOut(w.items, [true, true, true, true]);

  // A sensitive post: a declared viewer may open it, a visitor may not.
  await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, true]);
  await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, w.post.id));

  // A removed comment, then a deleted one (moderators still see removed content: never public).
  await writer().update(comments).set({ removedAt: new Date() }).where(eq(comments.id, w.comment.id));
  await expectPublicIsSignedOut(w.items, [true, false, true, true]);
  await writer().update(comments).set({ removedAt: null, deletedAt: new Date() }).where(eq(comments.id, w.comment.id));
  await expectPublicIsSignedOut(w.items, [true, false, true, true]);
  await writer().update(comments).set({ deletedAt: null }).where(eq(comments.id, w.comment.id));

  // A removed post takes its comments; a deleted one is a tombstone whose comments stay.
  await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, true]);
  await writer().update(posts).set({ removedAt: null, deletedAt: new Date() }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, true, true, true]);
  await writer().update(posts).set({ deletedAt: null }).where(eq(posts.id, w.post.id));

  // A sensitive community, then a deleted person, then a removed community.
  await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, w.community.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, false]);
  await writer().update(actors).set({ sensitive: false }).where(eq(actors.id, w.community.id));
  await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.author.id));
  await expectPublicIsSignedOut(w.items, [true, true, false, true]);
  await seedCommunityRemoval(w.community);
  await expectPublicIsSignedOut(w.items, [false, false, false, false]);
});

test('an unknown id is not public', async () => {
  await world();
  const missing = '0195f0a0-0000-7000-8000-000000000000';
  for (const kind of ['post', 'comment', 'actor'] as const) expect(await publicTags({ kind, id: missing }), kind).toBeNull();
});
