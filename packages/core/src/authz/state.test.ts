import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBan, seedComment, seedCommunityRemoval, seedModerator, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { commentCreate } from './__fixtures__/comment-create.ts';
import { authorize } from './authorize.ts';

// The guards other areas' policies call (state.ts): commentingDenial through a test-only
// comment.create policy (lane D writes the real one), participationDenial through vote.cast.

beforeEach(truncateAll);

async function setup() {
  const instance = await seedInstance('feddit.test');
  const author = await seedActor(instance, 'Person', 'author');
  const reader = await seedActor(instance, 'Person', 'reader');
  const moderator = await seedActor(instance, 'Person', 'moderator');
  const community = await seedActor(instance, 'Group', 'announcements');
  await seedModerator(community, moderator);
  const removed = await seedActor(instance, 'Group', 'closed');
  await seedCommunityRemoval(removed);
  const past = new Date(Date.now() - 1000);
  const post = await seedPost(instance, community, author);
  const lockedPost = await seedPost(instance, community, author, { locked: true });
  const removedPost = await seedPost(instance, community, author, { removedAt: past });
  return {
    instance,
    author,
    reader,
    moderator,
    community,
    post,
    lockedPost,
    removedPost,
    inRemovedCommunity: await seedPost(instance, removed, author),
    comment: await seedComment(instance, post, author),
    removedComment: await seedComment(instance, post, author, { removedAt: past }),
    commentUnderRemovedPost: await seedComment(instance, removedPost, author),
  };
}

const outcome = (result: { ok: true } | { ok: false; reason: string }) => (result.ok ? 'allow' : result.reason);

test('comment.create (fixture): a comment on a locked post is refused with post.locked', async () => {
  const w = await setup();
  const comment = async (actorId: string, postId: string, parentId: string | null = null) =>
    outcome(await commentCreate({ principal: localUser(actorId), subject: { postId, parentId }, db: db(), lock: false }));
  expect(await comment(w.reader.id, w.lockedPost.id)).toBe('post.locked');
  expect(await comment(w.reader.id, w.post.id)).toBe('allow');
  expect(await comment(w.reader.id, w.post.id, w.comment.id)).toBe('allow');
  expect(await comment(w.reader.id, w.post.id, w.removedComment.id)).toBe('target.removed');
  expect(await comment(w.reader.id, w.removedPost.id, w.commentUnderRemovedPost.id)).toBe('target.removed');
  expect(await comment(w.reader.id, w.lockedPost.id, w.comment.id)).toBe('target.not_found');
  expect(await comment(w.reader.id, w.inRemovedCommunity.id)).toBe('community.removed');
  await seedBan(w.community, w.reader);
  expect(await comment(w.reader.id, w.post.id)).toBe('community.banned');
});

describe('vote.cast through participationDenial', () => {
  test('refuses a banned voter, a removed target and a removed community; a lock does not stop votes', async () => {
    const w = await setup();
    const vote = async (actorId: string, kind: 'post' | 'comment', id: string) =>
      outcome(await authorize('vote.cast', localUser(actorId), { target: { kind, id } }));
    expect(await vote(w.reader.id, 'post', w.post.id)).toBe('allow');
    expect(await vote(w.reader.id, 'post', w.lockedPost.id)).toBe('allow');
    expect(await vote(w.reader.id, 'post', w.removedPost.id)).toBe('target.removed');
    expect(await vote(w.reader.id, 'comment', w.removedComment.id)).toBe('target.removed');
    expect(await vote(w.reader.id, 'post', w.inRemovedCommunity.id)).toBe('community.removed');
    await seedBan(w.community, w.reader);
    expect(await vote(w.reader.id, 'comment', w.comment.id)).toBe('community.banned');
  });
});
