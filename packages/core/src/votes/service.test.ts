import { parseEvent } from '@peblish/schema/events';
import type { ContentRef } from '@peblish/schema/ids';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '../db/read.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents, seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedAccount } from '../testing/seed-b1.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { voteAs } from './service.ts';

// voteAs against a post that becomes sensitive while the vote is under way. A hook runs once,
// at the moment a test names: right after voteAs's precheck (before its transaction opens), or
// right after the vote's transaction has committed. Everything else runs as it is.
const race = vi.hoisted(() => {
  const hooks: Partial<Record<'precheck' | 'committed', () => Promise<unknown>>> = {};
  return {
    hooks,
    async take(moment: 'precheck' | 'committed') {
      const hook = hooks[moment];
      delete hooks[moment];
      await hook?.();
    },
  };
});

vi.mock('../authz/authorize.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authz/authorize.ts')>();
  const authorize: typeof actual.authorize = async (action, principal, subject, options) => {
    const decision = await actual.authorize(action, principal, subject, options);
    // The recheck inside the transaction passes lock; the precheck does not.
    if (action === 'vote.cast' && !options?.lock) await race.take('precheck');
    return decision;
  };
  return { ...actual, authorize };
});

vi.mock('./cast.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cast.ts')>();
  const run = async (...args: Parameters<typeof actual.castVote>) => {
    const result = await actual.castVote(...args);
    await race.take('committed');
    return result;
  };
  return { ...actual, castVote: Object.assign(run, { within: actual.castVote.within }) };
});

const GATE = { ok: false, reason: 'age.declaration_required' };

beforeEach(async () => {
  await truncateAll();
  for (const moment of ['precheck', 'committed'] as const) delete race.hooks[moment];
});

async function world() {
  const local = await seedInstance('feddit.test');
  const community = await seedActor(local, 'Group', 'plain');
  const author = await seedAccount(local, 'author');
  const undeclared = await seedAccount(local, 'undeclared');
  const declared = await seedAccount(local, 'declared');
  await declareAge(declared);
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, author);
  const targets = { post: { kind: 'post', id: post.id }, comment: { kind: 'comment', id: comment.id } } satisfies Record<
    string,
    ContentRef
  >;
  return { postId: post.id, targets, undeclared: localUser(undeclared.id), declared: localUser(declared.id) };
}

/** Flags the post sensitive, so the age gate now withholds it and its comments from the undeclared voter. */
const flag = (postId: string) => async () => writer().update(posts).set({ sensitive: true }).where(eq(posts.id, postId));

const tally = async (target: ContentRef) => {
  const table = target.kind === 'post' ? posts : comments;
  const [row] = await db().select({ upvotes: table.upvotes, downvotes: table.downvotes }).from(table).where(eq(table.id, target.id));
  return row;
};
const heldVote = async (voterId: string, target: ContentRef) =>
  (
    await db()
      .select({ value: votes.value })
      .from(votes)
      .where(and(eq(votes.voterId, voterId), eq(target.kind === 'post' ? votes.postId : votes.commentId, target.id)))
  )[0]?.value ?? null;
const voteEvents = async () => (await outboxEvents()).map(parseEvent).filter((event) => event.type === 'vote.cast');

describe.each(['post', 'comment'] as const)('a %s that is flagged between the precheck and the transaction', (kind) => {
  test('taking back your own vote succeeds, sends the retraction and answers no tally', async () => {
    const w = await world();
    const target = w.targets[kind];
    expect(await voteAs(w.undeclared, target, 1)).toMatchObject({ ok: true, value: 1 });
    race.hooks.precheck = flag(w.postId);
    expect(await voteAs(w.undeclared, target, 0)).toEqual({ ok: true, value: 0, tally: null });
    expect([await heldVote(w.undeclared.actorId, target), await tally(target)]).toEqual([null, { upvotes: 0, downvotes: 0 }]);
    // The retraction is an event like any other, so the Undo reaches the peers that had the vote.
    expect((await voteEvents()).map((event) => [event.value, event.previous])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test('a new vote, or a change of vote, is refused and writes nothing', async () => {
    const w = await world();
    const target = w.targets[kind];
    race.hooks.precheck = flag(w.postId);
    expect(await voteAs(w.undeclared, target, 1)).toEqual(GATE);
    expect([await heldVote(w.undeclared.actorId, target), await voteEvents()]).toEqual([null, []]);

    await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, w.postId));
    expect(await voteAs(w.undeclared, target, 1)).toMatchObject({ ok: true, value: 1 });
    race.hooks.precheck = flag(w.postId);
    expect(await voteAs(w.undeclared, target, -1)).toEqual(GATE);
    expect([await heldVote(w.undeclared.actorId, target), await tally(target)]).toEqual([1, { upvotes: 1, downvotes: 0 }]);
  });

  test('taking back a vote you do not hold is refused', async () => {
    const w = await world();
    const target = w.targets[kind];
    race.hooks.precheck = flag(w.postId);
    expect(await voteAs(w.undeclared, target, 0)).toEqual(GATE);
    expect(await voteEvents()).toEqual([]);
  });
});

test('taking back a vote you do not hold: refused on gated content, answered as before on ordinary content', async () => {
  const w = await world();
  expect(await voteAs(w.undeclared, w.targets.post, 0)).toEqual({ ok: true, value: 0, tally: { upvotes: 0, downvotes: 0 } });
  await flag(w.postId)();
  for (const target of Object.values(w.targets)) expect(await voteAs(w.undeclared, target, 0)).toEqual(GATE);
  expect(await voteEvents()).toEqual([]);
});

test('the tally answered is the one the vote left, not one read after the post was flagged', async () => {
  const w = await world();
  const target = w.targets.post;
  // After the vote commits: the post is flagged and others' votes land.
  race.hooks.committed = async () => {
    await flag(w.postId)();
    await writer()
      .update(posts)
      .set({ upvotes: sql`${posts.upvotes} + 5` })
      .where(eq(posts.id, w.postId));
  };
  expect(await voteAs(w.undeclared, target, 1)).toEqual({ ok: true, value: 1, tally: { upvotes: 1, downvotes: 0 } });
});

test('a declared voter on ordinary content: a vote, a change and a take-back each answer the tally, and each is an event', async () => {
  const w = await world();
  for (const target of Object.values(w.targets)) {
    expect(await voteAs(w.declared, target, 1)).toEqual({ ok: true, value: 1, tally: { upvotes: 1, downvotes: 0 } });
    expect(await voteAs(w.declared, target, -1)).toEqual({ ok: true, value: -1, tally: { upvotes: 0, downvotes: 1 } });
    expect(await voteAs(w.declared, target, 0)).toEqual({ ok: true, value: 0, tally: { upvotes: 0, downvotes: 0 } });
  }
  const events = (await voteEvents()).map((event) => [event.target.kind, event.value, event.previous]);
  expect(events).toEqual([
    ['post', 1, 0],
    ['post', -1, 1],
    ['post', 0, -1],
    ['comment', 1, 0],
    ['comment', -1, 1],
    ['comment', 0, -1],
  ]);
});
