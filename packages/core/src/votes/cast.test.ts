import type { Principal } from '@peblish/schema/authz';
import { parseEvent } from '@peblish/schema/events';
import type { ContentRef } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedComment } from '../testing/seed-az.ts';
import { sameTransaction, seedAccount, seedPostWorld } from '../testing/seed-b1.ts';
import { localUser } from '../testing/seed.ts';
import { castVote } from './cast.ts';

beforeEach(truncateAll);

async function setup() {
  const world = await seedPostWorld();
  const postId = world.posts.local.normal;
  const comment = await seedComment(world.instances.local, { id: postId }, world.people.author);
  const target = { kind: 'post', id: postId } as const;
  const commentTarget = { kind: 'comment', id: comment.id } as const;
  const reader = localUser(world.people.reader.id);
  const remote: Principal = { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null };
  return { world, postId, comment, target, commentTarget, reader, remote };
}

const cast = async (principal: Principal, target: ContentRef, input: Parameters<typeof castVote>[1]) =>
  castVote(await grantFor('vote.cast', principal, { target }), input);

const tally = async (target: ContentRef) => {
  const table = target.kind === 'post' ? posts : comments;
  const [row] = await db().select({ upvotes: table.upvotes, downvotes: table.downvotes }).from(table).where(eq(table.id, target.id));
  return row;
};
const voteRows = (voterId: string) => db().select().from(votes).where(eq(votes.voterId, voterId));
const voteEvents = async () => (await outboxEvents()).map(parseEvent).filter((event) => event.type === 'vote.cast');

describe('castVote', () => {
  test('a vote, a change of direction and a retraction keep the counts, and name the Like ids in the events', async () => {
    const { world, target, reader } = await setup();
    const voterId = world.people.reader.id;

    expect(await cast(reader, target, { value: 1 })).toEqual({ changed: true, value: 1 });
    const [up] = await voteRows(voterId);
    expect(up).toMatchObject({ value: 1, local: true, postId: target.id, commentId: null });
    expect(up?.apId).toMatch(/^https:\/\/feddit\.test\/ap\/activity\/[0-9a-f-]{36}$/);
    expect(await tally(target)).toEqual({ upvotes: 1, downvotes: 0 });
    expect(await sameTransaction('votes', up!.id, 'vote.cast')).toBe(true);

    // A change of direction deletes the row and inserts a new one under a new id.
    await cast(reader, target, { value: -1 });
    const [down] = await voteRows(voterId);
    expect(down).toMatchObject({ value: -1 });
    expect(down?.id).not.toBe(up?.id);
    expect(down?.apId).not.toBe(up?.apId);
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 1 });

    await cast(reader, target, { value: 0 });
    expect(await voteRows(voterId)).toEqual([]);
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 0 });

    const base = { type: 'vote.cast', v: 1, voterId, target, local: true };
    expect(await voteEvents()).toEqual([
      { ...base, value: 1, previous: 0, apId: up?.apId, previousApId: null },
      { ...base, value: -1, previous: 1, apId: down?.apId, previousApId: up?.apId },
      { ...base, value: 0, previous: -1, apId: null, previousApId: down?.apId },
    ]);
  });

  test('casting what is already cast, or retracting nothing, changes nothing and emits nothing', async () => {
    const { target, reader } = await setup();
    await cast(reader, target, { value: 0 });
    await cast(reader, target, { value: 1 });
    expect(await cast(reader, target, { value: 1 })).toEqual({ changed: false, value: 1 });
    expect(await tally(target)).toEqual({ upvotes: 1, downvotes: 0 });
    expect(await voteEvents()).toHaveLength(1);
  });

  test("a comment vote changes the comment's tally only", async () => {
    const { target, commentTarget, reader } = await setup();
    await cast(reader, commentTarget, { value: -1 });
    expect(await tally(commentTarget)).toEqual({ upvotes: 0, downvotes: 1 });
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 0 });
    await cast(reader, commentTarget, { value: 1 });
    expect(await tally(commentTarget)).toEqual({ upvotes: 1, downvotes: 0 });
    // The same person votes on the post and the comment independently.
    await cast(reader, target, { value: 1 });
    expect(await tally(target)).toEqual({ upvotes: 1, downvotes: 0 });
  });

  test("a remote Undo(Like) carries a new Like id and still retracts that voter's vote", async () => {
    const { world, target, remote } = await setup();
    const voterId = world.people.remoteAuthor.id;
    await cast(remote, target, { value: 1, apId: 'https://lemmy.test/activities/like/1', raw: { type: 'Like' } });
    const [row] = await voteRows(voterId);
    expect(row).toMatchObject({
      apId: 'https://lemmy.test/activities/like/1',
      local: false,
      value: 1,
      instanceId: world.instances.lemmy.id,
    });
    expect(await tally(target)).toEqual({ upvotes: 1, downvotes: 0 });

    // Lemmy's Undo embeds a freshly minted Like id: the caller passes value 0 and no id.
    expect(await cast(remote, target, { value: 0 })).toEqual({ changed: true, value: 0 });
    expect(await voteRows(voterId)).toEqual([]);
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 0 });
    expect((await voteEvents()).at(-1)).toMatchObject({
      voterId,
      local: false,
      value: 0,
      previous: 1,
      apId: null,
      previousApId: 'https://lemmy.test/activities/like/1',
    });
  });

  test("a remote Dislike after a Like replaces it under the peer's new id", async () => {
    const { target, remote } = await setup();
    await cast(remote, target, { value: 1, apId: 'https://lemmy.test/activities/like/1' });
    await cast(remote, target, { value: -1, apId: 'https://lemmy.test/activities/dislike/2' });
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 1 });
    expect((await voteEvents()).at(-1)).toMatchObject({
      value: -1,
      previous: 1,
      apId: 'https://lemmy.test/activities/dislike/2',
      previousApId: 'https://lemmy.test/activities/like/1',
    });
  });

  test("a local voter cannot choose the vote's id, and a remote vote must bring one", async () => {
    const { target, reader, remote } = await setup();
    await expect(cast(reader, target, { value: 1, apId: 'https://evil.test/activities/like/1' })).rejects.toThrow(TypeError);
    await expect(cast(remote, target, { value: 1 })).rejects.toThrow(TypeError);
    await expect(cast(reader, target, { value: 2 as 1 })).rejects.toThrow();
    expect(await voteEvents()).toEqual([]);
    expect(await tally(target)).toEqual({ upvotes: 0, downvotes: 0 });
  });

  test('a removal that lands after authorize() refuses the vote and writes nothing', async () => {
    const { target, reader } = await setup();
    const grant = await grantFor('vote.cast', reader, { target });
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, target.id));
    await expect(castVote(grant, { value: 1 })).rejects.toMatchObject({ name: 'Refused', reason: 'target.removed' });
    expect(await voteEvents()).toEqual([]);
  });

  test('many voters at once, and one voter double-clicking, leave exact counts', async () => {
    const { world, target } = await setup();
    const voters = await Promise.all(Array.from({ length: 8 }, (_, i) => seedAccount(world.instances.local, `voter${i}`)));
    await Promise.all(voters.map((voter, i) => cast(localUser(voter.id), target, { value: i % 2 === 0 ? 1 : -1 })));
    expect(await tally(target)).toEqual({ upvotes: 4, downvotes: 4 });
    const twice = localUser(world.people.reader.id);
    await Promise.all([cast(twice, target, { value: 1 }), cast(twice, target, { value: 1 })]);
    expect(await tally(target)).toEqual({ upvotes: 5, downvotes: 4 });
    expect(
      await db()
        .select()
        .from(votes)
        .where(and(eq(votes.voterId, world.people.reader.id), eq(votes.postId, target.id))),
    ).toHaveLength(1);
  });
});
