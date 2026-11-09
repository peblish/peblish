import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { posts, votes } from '../db/tables/content.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { localUser } from '../testing/seed.ts';
import { voteAs } from '../votes/service.ts';
import { createPostAs, deletePostAs, removePostAs, restorePostAs, restoreRemovedPostAs, updatePostAs } from './actions.ts';

beforeEach(truncateAll);

// The web-facing wrappers turn every refusal, the precheck's and the transaction's, into a result.

test('a refusal comes back as a result, from the precheck and from the recheck', async () => {
  const world = await seedPostWorld();
  const author = localUser(world.people.author.id);
  const community = world.communities.open.id;
  expect(await createPostAs({ kind: 'anonymous' }, community, { title: 'x' })).toEqual({ ok: false, reason: 'auth.required' });
  expect(await createPostAs(localUser(world.people.unverified.id), community, { title: 'x' })).toEqual({
    ok: false,
    reason: 'auth.email_unverified',
  });
  const created = await createPostAs(author, community, { title: 'Mine', bodyMd: 'text' });
  if (!created.ok) throw new Error(created.reason);

  expect(await updatePostAs(author, created.id, { title: 'Renamed' })).toEqual({ ok: true, changed: true });
  expect(await updatePostAs(localUser(world.people.reader.id), created.id, { title: 'Hijacked' })).toEqual({
    ok: false,
    reason: 'post.author_required',
  });

  // A double submit: both pass the precheck or one is refused inside its transaction; either way one result is ok and one is target.deleted.
  const results = await Promise.all([deletePostAs(author, created.id), deletePostAs(author, created.id)]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'target.deleted' }]);
  expect(await restorePostAs(author, created.id)).toEqual({ ok: true });
});

test('a new post starts with its author upvote, as Lemmy and PieFed give it', async () => {
  const world = await seedPostWorld();
  const author = localUser(world.people.author.id);
  const created = await createPostAs(author, world.communities.open.id, { title: 'Mine' });
  if (!created.ok) throw new Error(created.reason);

  const [post] = await db().select({ upvotes: posts.upvotes, downvotes: posts.downvotes }).from(posts).where(eq(posts.id, created.id));
  expect(post).toEqual({ upvotes: 1, downvotes: 0 });
  const rows = await db().select({ voterId: votes.voterId, value: votes.value }).from(votes).where(eq(votes.postId, created.id));
  expect(rows).toEqual([{ voterId: world.people.author.id, value: 1 }]);
  // The vote federates like any other: one vote.cast after the post's own event.
  expect(await outboxEvents()).toMatchObject([
    { type: 'post.created', postId: created.id, authorId: world.people.author.id },
    { type: 'vote.cast', voterId: world.people.author.id, target: { kind: 'post', id: created.id }, value: 1, local: true },
  ]);
});

test('a moderator removes and restores a post with a reason; anyone else is refused', async () => {
  const world = await seedPostWorld();
  const id = world.posts.local.normal;
  const moderator = localUser(world.people.moderator.id);
  expect(await removePostAs(localUser(world.people.reader.id), id, 'spam')).toEqual({ ok: false, reason: 'mod.moderator_required' });
  expect(await removePostAs(moderator, id, 'Rule 2: off topic')).toMatchObject({ ok: true });
  const [removed] = await db().select({ removedAt: posts.removedAt }).from(posts).where(eq(posts.id, id));
  expect(removed?.removedAt).toBeInstanceOf(Date);
  expect(await restoreRemovedPostAs(moderator, id, null)).toMatchObject({ ok: true });
  const [restored] = await db().select({ removedAt: posts.removedAt }).from(posts).where(eq(posts.id, id));
  expect(restored?.removedAt).toBeNull();
});

test('a vote answers with the vote held and the tally', async () => {
  const world = await seedPostWorld();
  const reader = localUser(world.people.reader.id);
  const target = { kind: 'post', id: world.posts.local.normal } as const;
  expect(await voteAs(reader, target, 1)).toEqual({ ok: true, value: 1, tally: { upvotes: 1, downvotes: 0 } });
  expect(await voteAs(reader, target, 0)).toEqual({ ok: true, value: 0, tally: { upvotes: 0, downvotes: 0 } });
  expect(await voteAs({ kind: 'anonymous' }, target, 1)).toEqual({ ok: false, reason: 'auth.required' });
  expect(await voteAs(reader, { kind: 'post', id: world.posts.local.removed }, 1)).toEqual({ ok: false, reason: 'target.removed' });
});
