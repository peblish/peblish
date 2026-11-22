import type { Principal } from '@peblish/schema/authz';
import type { ContentRef } from '@peblish/schema/ids';
import { parseEvent } from '@peblish/schema/events';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, test } from 'vitest';
import { restoreAs } from '../bans/service.ts';
import { createCommentAs } from '../comments/actions.ts';
import { comments, posts as postRows, votes } from '../db/tables/content.ts';
import { db, type Queryable } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { admin as siteAdmin, outboxEvents, seedAdmin, seedComment, seedModerator, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedAccount } from '../testing/seed-b1.ts';
import { seedFollow } from '../testing/seed-c1.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { voteAs } from '../votes/service.ts';
import { tx } from '../tx/tx.ts';
import { authorize, type Decision } from './authorize.ts';
import type { ActionName, SubjectOf } from './policy.ts';

// The sensitive-content gate on the writes a person makes in a thread (C10): the post page shows
// a sensitive or NSFL post, or anything in a sensitive or NSFL community, only to someone who
// declared 16+, so someone who has not cannot comment on it, vote on it or its comments, post
// into or follow such a community, or edit or restore their own words in it. Retracting their own
// words or vote, unfollowing and reporting stay open. What peers send is not gated here. Hide
// NSFW is the browser's and plays no part.

const GATE = 'age.declaration_required';
const OK = 'allow';

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const declared = await seedAccount(local, 'declared');
  await declareAge(declared);
  const undeclared = await seedAccount(local, 'undeclared');
  const remote = await seedActor(lemmy, 'Person', 'visitor');
  const plain = await seedActor(local, 'Group', 'plain');
  const adult = await seedActor(local, 'Group', 'adult', { sensitive: true });
  const gore = await seedActor(local, 'Group', 'gore', { nsfl: true });
  const author = await seedAccount(local, 'author');
  const post = async (community: { id: string }, extra: Parameters<typeof seedPost>[3] = {}, by: { id: string } = author) =>
    (await seedPost(local, community, by, extra)).id;
  const posts = {
    plain: await post(plain),
    sensitive: await post(plain, { sensitive: true }),
    nsfl: await post(plain, { nsfl: true }),
    inAdult: await post(adult),
    inGore: await post(gore),
  };
  const comment = async (postId: string, by: { id: string }, extra: Parameters<typeof seedComment>[3] = {}) =>
    (await seedComment(local, { id: postId }, by, extra)).id;
  // What the undeclared person wrote before the post or its community was flagged (or imported).
  const own = {
    onPlain: await comment(posts.plain, undeclared),
    onSensitive: await comment(posts.sensitive, undeclared),
    deletedOnPlain: await comment(posts.plain, undeclared, { deletedAt: new Date() }),
    deletedOnSensitive: await comment(posts.sensitive, undeclared, { deletedAt: new Date() }),
    plainPost: await post(plain, {}, undeclared),
    sensitivePost: await post(plain, { sensitive: true }, undeclared),
    deletedPlainPost: await post(plain, { deletedAt: new Date() }, undeclared),
    deletedSensitivePost: await post(plain, { sensitive: true, deletedAt: new Date() }, undeclared),
  };
  const others = { onPlain: await comment(posts.plain, author), onSensitive: await comment(posts.sensitive, author) };
  // Votes and a follow the undeclared person made before the post or the community was flagged.
  await seedFollow(undeclared, adult);
  const votedPost = await post(plain);
  const votedThread = await post(plain);
  const voted = {
    post: { kind: 'post', id: votedPost },
    comment: { kind: 'comment', id: await comment(votedThread, author) },
  } satisfies Record<string, ContentRef>;
  for (const target of Object.values(voted)) {
    const cast = await voteAs(localUser(undeclared.id), target, 1);
    if (!cast.ok) throw new Error(cast.reason);
  }
  for (const id of [votedPost, votedThread]) await writer().update(postRows).set({ sensitive: true }).where(eq(postRows.id, id));
  // Staff of the plain community (a moderator of it, and a site admin with two-factor, which an
  // admin needs to count as one), and what a moderator removed of theirs and of the author's.
  const staff = {
    moderator: await seedAccount(local, 'moderator'),
    declaredModerator: await seedAccount(local, 'declared_moderator'),
    admin: await seedAdmin(local, 'site_admin'),
  };
  await seedModerator(plain, staff.moderator);
  await seedModerator(plain, staff.declaredModerator);
  await declareAge(staff.declaredModerator);
  const removedBy = async (by: { id: string }, sensitive: boolean): Promise<ContentRef[]> => {
    const postId = await post(plain, { sensitive, removedAt: new Date() }, by);
    const onPost = await post(plain, { sensitive });
    return [
      { kind: 'post', id: postId },
      { kind: 'comment', id: await comment(onPost, by, { removedAt: new Date() }) },
    ];
  };
  const removed = {
    moderator: { gated: await removedBy(staff.moderator, true), plain: await removedBy(staff.moderator, false) },
    declaredModerator: { gated: await removedBy(staff.declaredModerator, true) },
    admin: { gated: await removedBy(staff.admin, true), plain: await removedBy(staff.admin, false) },
    author: { gated: await removedBy(author, true) },
  };
  return { declared, undeclared, remote, communities: { plain, adult, gore }, posts, own, others, voted, staff, removed };
}

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  await truncateAll();
  w = await world();
});

const remote = (actorId: string): Principal => ({ kind: 'remote', actorId, announcedBy: null });
const admin = (actorId: string): Principal => ({ kind: 'local', actorId, siteRole: 'admin' });

type Options = { db?: Queryable; lock?: boolean };
const run = <T>(lock: boolean, decide: (options: Options) => Promise<T>) =>
  lock ? tx((t) => decide({ db: t.db, lock: true })) : decide({});
const outcome = (decision: Decision<ActionName>) => (decision.ok ? OK : decision.reason);

async function decide<A extends ActionName>(lock: boolean, action: A, principal: Principal, subject: SubjectOf<A>) {
  return run(lock, async (options) => outcome(await authorize(action, principal, subject, options)));
}

describe.each([
  { mode: 'precheck', lock: false },
  { mode: 'recheck', lock: true },
])('$mode', ({ lock }) => {
  const on = (postId: () => string) => () => ({ postId: postId(), parentId: null });
  const flaggedPosts = {
    sensitive: () => w.posts.sensitive,
    nsfl: () => w.posts.nsfl,
    inAdult: () => w.posts.inAdult,
    inGore: () => w.posts.inGore,
  };

  test.each(Object.entries(flaggedPosts))('a comment on a flagged post (%s): only from someone who declared 16+', async (_, postId) => {
    expect(await decide(lock, 'comment.create', localUser(w.undeclared.id), on(postId)())).toBe(GATE);
    // A site admin has no way around the gate either: the page withholds the post from them too.
    expect(await decide(lock, 'comment.create', admin(w.undeclared.id), on(postId)())).toBe(GATE);
    expect(await decide(lock, 'comment.create', localUser(w.declared.id), on(postId)())).toBe(OK);
    // A reply to a comment there is the same.
    const reply = { postId: w.posts.sensitive, parentId: w.others.onSensitive };
    expect(await decide(lock, 'comment.create', localUser(w.undeclared.id), reply)).toBe(GATE);
  });

  test('a comment on a post nothing flags is as before', async () => {
    expect(await decide(lock, 'comment.create', localUser(w.undeclared.id), on(() => w.posts.plain)())).toBe(OK);
    expect(await decide(lock, 'comment.create', localUser(w.declared.id), on(() => w.posts.plain)())).toBe(OK);
  });

  test('what a peer sends is not gated here', async () => {
    expect(await decide(lock, 'comment.create', remote(w.remote.id), on(() => w.posts.sensitive)())).toBe(OK);
    expect(await decide(lock, 'comment.create', remote(w.remote.id), on(() => w.posts.inAdult)())).toBe(OK);
    expect(await decide(lock, 'vote.cast', remote(w.remote.id), { target: { kind: 'post', id: w.posts.sensitive } })).toBe(OK);
  });

  test('votes on a flagged post and on its comments', async () => {
    const targets = [
      { kind: 'post', id: w.posts.sensitive },
      { kind: 'post', id: w.posts.inAdult },
      { kind: 'comment', id: w.others.onSensitive },
    ] as const;
    for (const target of targets) {
      expect([target, await decide(lock, 'vote.cast', localUser(w.undeclared.id), { target })]).toEqual([target, GATE]);
      expect([target, await decide(lock, 'vote.cast', localUser(w.declared.id), { target })]).toEqual([target, OK]);
    }
    expect(await decide(lock, 'vote.cast', localUser(w.undeclared.id), { target: { kind: 'comment', id: w.others.onPlain } })).toBe(OK);
  });

  // The report form is the one page that opens for gated content: it names what is reported and
  // withholds the quote (reports/form.ts), so a report is taken as before.
  test('a report of a flagged post or comment is taken from anyone, as the report form opens for them', async () => {
    const report = (target: SubjectOf<'report.create'>['target']) => ({ target, category: 'spam', forward: false }) as const;
    for (const target of [
      { kind: 'post', id: w.posts.sensitive },
      { kind: 'comment', id: w.others.onSensitive },
    ] as const) {
      expect(await decide(lock, 'report.create', localUser(w.undeclared.id), report(target))).toBe(OK);
      expect(await decide(lock, 'report.create', localUser(w.declared.id), report(target))).toBe(OK);
    }
    expect(await decide(lock, 'report.create', localUser(w.undeclared.id), report({ kind: 'post', id: w.posts.plain }))).toBe(OK);
    expect(await decide(lock, 'report.create', localUser(w.undeclared.id), report({ kind: 'actor', id: w.communities.adult.id }))).toBe(OK);
  });

  test('a follow of a flagged community: only from someone who declared 16+, and unfollowing stays open', async () => {
    for (const community of [w.communities.adult, w.communities.gore]) {
      expect(await decide(lock, 'follow.request', localUser(w.undeclared.id), { communityId: community.id })).toBe(GATE);
      expect(await decide(lock, 'follow.request', localUser(w.declared.id), { communityId: community.id })).toBe(OK);
    }
    expect(await decide(lock, 'follow.request', localUser(w.undeclared.id), { communityId: w.communities.plain.id })).toBe(OK);
    const unfollow = { followerId: w.undeclared.id, followeeId: w.communities.adult.id, apId: null };
    expect(await decide(lock, 'follow.remove', localUser(w.undeclared.id), unfollow)).toBe(OK);
  });

  test('your own vote on what has since been gated can be taken back, and nothing else done to it', async () => {
    const me = localUser(w.undeclared.id);
    for (const target of Object.values(w.voted)) {
      expect([target, await decide(lock, 'vote.cast', me, { target, withdraw: true })]).toEqual([target, OK]);
      expect([target, await decide(lock, 'vote.cast', me, { target })]).toEqual([target, GATE]);
    }
    // Without a vote of theirs there, there is nothing to take back.
    expect(await decide(lock, 'vote.cast', me, { target: { kind: 'post', id: w.posts.sensitive }, withdraw: true })).toBe(GATE);
  });

  // mod.restore clears a moderator's removal. Restoring your own removed words where the page
  // withholds them is gated as the author's own restore is; someone else's stays staff work.
  test('a moderator or an admin restoring their own removed words where they cannot see them: only once declared', async () => {
    const moderator = localUser(w.staff.moderator.id);
    const admin = siteAdmin(w.staff.admin.id);
    for (const target of w.removed.moderator.gated) {
      expect([target, await decide(lock, 'mod.restore', moderator, { target })]).toEqual([target, GATE]);
    }
    for (const target of w.removed.admin.gated) {
      expect([target, await decide(lock, 'mod.restore', admin, { target })]).toEqual([target, GATE]);
    }
    // Where nothing is flagged, as before.
    for (const target of w.removed.moderator.plain) expect(await decide(lock, 'mod.restore', moderator, { target })).toBe(OK);
    for (const target of w.removed.admin.plain) expect(await decide(lock, 'mod.restore', admin, { target })).toBe(OK);
  });

  test("restoring someone else's removed words, and a declared moderator's own, are as before", async () => {
    const declaredModerator = localUser(w.staff.declaredModerator.id);
    for (const target of [...w.removed.declaredModerator.gated, ...w.removed.author.gated]) {
      expect([target, await decide(lock, 'mod.restore', declaredModerator, { target })]).toEqual([target, OK]);
    }
    for (const target of w.removed.author.gated) {
      expect([target, await decide(lock, 'mod.restore', localUser(w.staff.moderator.id), { target })]).toEqual([target, OK]);
      expect([target, await decide(lock, 'mod.restore', siteAdmin(w.staff.admin.id), { target })]).toEqual([target, OK]);
    }
  });

  test('a post into a flagged community', async () => {
    for (const community of [w.communities.adult, w.communities.gore]) {
      expect(await decide(lock, 'post.create', localUser(w.undeclared.id), { communityId: community.id })).toBe(GATE);
      expect(await decide(lock, 'post.create', localUser(w.declared.id), { communityId: community.id })).toBe(OK);
    }
    expect(await decide(lock, 'post.create', localUser(w.undeclared.id), { communityId: w.communities.plain.id })).toBe(OK);
  });

  test('your own words where you cannot see them: no edit and no restore, but you may still retract them', async () => {
    const me = localUser(w.undeclared.id);
    expect(await decide(lock, 'comment.update', me, { commentId: w.own.onSensitive })).toBe(GATE);
    expect(await decide(lock, 'comment.delete', me, { commentId: w.own.onSensitive })).toBe(OK);
    expect(await decide(lock, 'comment.restore', me, { commentId: w.own.deletedOnSensitive })).toBe(GATE);
    expect(await decide(lock, 'post.update', me, { postId: w.own.sensitivePost })).toBe(GATE);
    expect(await decide(lock, 'post.delete', me, { postId: w.own.sensitivePost })).toBe(OK);
    expect(await decide(lock, 'post.restore', me, { postId: w.own.deletedSensitivePost })).toBe(GATE);
    // Where nothing is flagged, as before.
    expect(await decide(lock, 'comment.update', me, { commentId: w.own.onPlain })).toBe(OK);
    expect(await decide(lock, 'comment.restore', me, { commentId: w.own.deletedOnPlain })).toBe(OK);
    expect(await decide(lock, 'post.update', me, { postId: w.own.plainPost })).toBe(OK);
    expect(await decide(lock, 'post.restore', me, { postId: w.own.deletedPlainPost })).toBe(OK);
  });
});

test('a direct comment request on a flagged post writes nothing; once declared, it goes through', async () => {
  const where = { postId: w.posts.inAdult, parentId: null };
  const before = await db().select({ id: comments.id }).from(comments).where(eq(comments.postId, where.postId));
  expect(await createCommentAs(localUser(w.undeclared.id), where, { bodyMd: 'hello' })).toEqual({ ok: false, reason: GATE });
  expect(await db().select({ id: comments.id }).from(comments).where(eq(comments.postId, where.postId))).toEqual(before);
  expect(await createCommentAs(localUser(w.declared.id), where, { bodyMd: 'hello' })).toMatchObject({ ok: true });
});

test("a direct restore of a moderator's own removed post where they cannot see it writes nothing", async () => {
  const [target] = w.removed.moderator.gated;
  if (target?.kind !== 'post') throw new Error('the first removed target is a post');
  const removedAt = async () => (await db().select({ at: postRows.removedAt }).from(postRows).where(eq(postRows.id, target.id)))[0]?.at;
  expect(await restoreAs(localUser(w.staff.moderator.id), target, { reason: 'Mine' })).toEqual({ ok: false, reason: GATE });
  expect(await removedAt()).not.toBeNull();
  // A declared moderator restores it.
  expect(await restoreAs(localUser(w.staff.declaredModerator.id), target, { reason: 'Theirs' })).toMatchObject({ ok: true });
  expect(await removedAt()).toBeNull();
});

test('taking back a vote on gated content sends the retraction and answers with nothing of the content', async () => {
  const me = localUser(w.undeclared.id);
  const { post } = w.voted;
  const tally = async () => (await db().select({ up: postRows.upvotes }).from(postRows).where(eq(postRows.id, post.id)))[0]?.up;
  expect(await tally()).toBe(1);
  // Casting again, or the other way, stays refused.
  for (const value of [1, -1] as const) expect(await voteAs(me, post, value)).toEqual({ ok: false, reason: GATE });
  expect(await voteAs(me, post, 0)).toEqual({ ok: true, value: 0, tally: null });
  const own = await db()
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.voterId, w.undeclared.id), eq(votes.postId, post.id)));
  expect([own, await tally()]).toEqual([[], 0]);
  // The retraction is an event like any other, so the outbound Undo goes to the peers that had the vote.
  const retracted = (await outboxEvents())
    .map(parseEvent)
    .filter((event) => event.type === 'vote.cast' && event.target.id === post.id && event.value === 0);
  expect(retracted).toHaveLength(1);
  // Taken back once: there is nothing left to take back.
  expect(await voteAs(me, post, 0)).toEqual({ ok: false, reason: GATE });
  // A declared voter's retraction answers with the tally, as before.
  const theirs = { kind: 'comment', id: w.others.onPlain } as const;
  await voteAs(localUser(w.declared.id), theirs, 1);
  expect(await voteAs(localUser(w.declared.id), theirs, 0)).toEqual({ ok: true, value: 0, tally: { upvotes: 0, downvotes: 0 } });
});
