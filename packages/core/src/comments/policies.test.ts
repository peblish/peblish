import type { Principal } from '@peblish/schema/authz';
import { beforeAll, describe, expect, test } from 'vitest';
import { authorize, type Decision } from '../authz/authorize.ts';
import type { ActionName } from '../authz/policy.ts';
import type { Queryable } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedCommentWorld } from '../testing/seed-d.ts';
import { localUser } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';

// The policy table of the comment actions: every principal against every post and parent
// state, allow or the exact refusal, as a precheck (no lock) and as a recheck (inside the
// transaction, with the principal re-read and every row locked).

type World = Awaited<ReturnType<typeof seedCommentWorld>>;
let world: World;
beforeAll(async () => {
  await truncateAll();
  world = await seedCommentWorld();
});

const OK = 'allow';
const REQ = 'auth.required';
const UNV = 'auth.email_unverified';
const BAN = 'community.banned';
const CRM = 'community.removed';
const MIS = 'mod.announce_mismatch';
const AUT = 'comment.author_required';
const GRP = 'comment.group_cannot_act';
const DEEP = 'comment.depth_exceeded';
const LCK = 'post.locked';
const DEL = 'target.deleted';
const NDEL = 'comment.not_deleted';
const REM = 'target.removed';
const NOT = 'target.not_found';

type Options = { db?: Queryable; lock?: boolean };
const outcome = (decision: Decision<ActionName>) => (decision.ok ? OK : decision.reason);
const run = <T>(lock: boolean, decide: (options: Options) => Promise<T>) =>
  lock ? tx((t) => decide({ db: t.db, lock: true })) : decide({});

/** One at a time: each recheck holds its row locks until its transaction ends. */
async function each<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await fn(item));
  return results;
}

const anonymous = (): Principal => ({ kind: 'anonymous' });
const remote = (actorId: string, announcedBy: { communityId: string } | null = null): Principal => ({
  kind: 'remote',
  actorId,
  announcedBy: announcedBy && { ...announcedBy, announceApId: 'https://lemmy.test/activities/announce/1' },
});
const admin = (actorId: string): Principal => ({ kind: 'local', actorId, siteRole: 'admin' });
const system = (actorId: string): Principal => ({ kind: 'system', actorId, job: 'scheduled' });

describe.each([
  { mode: 'precheck', lock: false },
  { mode: 'recheck', lock: true },
])('$mode', ({ lock }) => {
  const columns = [
    'post',
    'locked post',
    'removed post',
    'deleted post',
    'community removed',
    'comment',
    'deleted comment',
    'removed comment',
    'level 49',
    'level 50',
    'other post',
    'remote post',
  ] as const;
  type Column = (typeof columns)[number];
  const subjects: Record<Column, () => { postId: string; parentId: string | null }> = {
    post: () => ({ postId: world.posts.local.normal, parentId: null }),
    'locked post': () => ({ postId: world.posts.local.locked, parentId: null }),
    'removed post': () => ({ postId: world.posts.local.removed, parentId: null }),
    'deleted post': () => ({ postId: world.posts.local.deleted, parentId: null }),
    'community removed': () => ({ postId: world.posts.local['community removed'], parentId: null }),
    comment: () => ({ postId: world.posts.local.normal, parentId: world.comments.local.normal }),
    'deleted comment': () => ({ postId: world.posts.local.normal, parentId: world.comments.local.deleted }),
    'removed comment': () => ({ postId: world.posts.local.normal, parentId: world.comments.local.removed }),
    'level 49': () => ({ postId: world.posts.deep, parentId: world.comments.deep.level49 }),
    'level 50': () => ({ postId: world.posts.deep, parentId: world.comments.deep.level50 }),
    // A parent that belongs to another post is not a reply to this one.
    'other post': () => ({ postId: world.posts.local.normal, parentId: world.comments.local.onLocked }),
    'remote post': () => ({ postId: world.posts.remote.normal, parentId: null }),
  };
  const create = (principal: Principal, column: Column) =>
    run(lock, async (options) => outcome(await authorize('comment.create', principal, subjects[column](), options)));

  type Expected = Record<Column, string>;
  const everywhere = (reason: string): Expected => Object.fromEntries(columns.map((column) => [column, reason])) as Expected;
  // What any local person with a verified email gets: open where the post and parent are live and unlocked.
  const verified: Expected = {
    post: OK,
    'locked post': LCK,
    'removed post': REM,
    'deleted post': DEL,
    'community removed': CRM,
    comment: OK,
    'deleted comment': DEL,
    'removed comment': REM,
    'level 49': OK,
    'level 50': DEEP,
    'other post': NOT,
    'remote post': OK,
  };
  // Banned from the open community: refused in each of its posts, before the post's own state
  // (not in the removed community, which is refused first, nor for a parent that is not this post's).
  const banned: Expected = {
    ...verified,
    post: BAN,
    'locked post': BAN,
    'removed post': BAN,
    'deleted post': BAN,
    comment: BAN,
    'deleted comment': BAN,
    'removed comment': BAN,
    'level 49': BAN,
    'level 50': BAN,
  };

  const creates: { who: string; principal: () => Principal; expected: Expected }[] = [
    { who: 'anonymous', principal: anonymous, expected: everywhere(REQ) },
    { who: 'the instance itself', principal: () => system(world.instances.local.id), expected: everywhere(REQ) },
    // A community does not comment; refused before any lock.
    { who: 'a remote community', principal: () => remote(world.communities.remote.id), expected: everywhere(GRP) },
    { who: 'unverified email', principal: () => localUser(world.people.unverified.id), expected: everywhere(UNV) },
    { who: 'local user', principal: () => localUser(world.people.reader.id), expected: verified },
    { who: 'author of the post', principal: () => localUser(world.people.author.id), expected: verified },
    // A lock stops moderators, owners and site admins as it stops everyone: post.locked is final.
    { who: 'community moderator', principal: () => localUser(world.people.moderator.id), expected: verified },
    { who: 'community owner', principal: () => localUser(world.people.owner.id), expected: verified },
    { who: 'site admin', principal: () => admin(world.people.admin.id), expected: verified },
    { who: 'banned from the community', principal: () => localUser(world.people.banned.id), expected: banned },
    { who: 'remote author, direct', principal: () => remote(world.people.remoteAuthor.id), expected: verified },
    {
      who: "remote author, the remote community's Announce",
      principal: () => remote(world.people.remoteAuthor.id, { communityId: world.communities.remote.id }),
      // An Announce can only come from the remote community the post is in: a local community's
      // posts are not its to carry. That is checked after the guards and before the depth.
      expected: {
        ...verified,
        post: MIS,
        comment: MIS,
        'level 49': MIS,
        'level 50': MIS,
      },
    },
  ];

  test.each(creates)('comment.create: $who', async ({ principal, expected }) => {
    const actual = Object.fromEntries(await each(columns, async (column) => [column, await create(principal(), column)] as const));
    expect(actual).toEqual(expected);
  });

  test('an Announce from another community than the post is in is a mismatch', async () => {
    const other = remote(world.people.remoteAuthor.id, { communityId: world.communities.remoteRestricted.id });
    expect(await create(other, 'remote post')).toBe(MIS);
  });

  const authorActions = ['comment.update', 'comment.delete', 'comment.restore'] as const;
  const act = (action: (typeof authorActions)[number], principal: Principal, commentId: string) =>
    run(lock, async (options) => outcome(await authorize(action, principal, { commentId }, options)));

  // The reader's own comments in each state; update, delete, restore. Only a deleted comment
  // restores, and a moderator's removal is not the author's to undo.
  const asAuthor: Record<string, [string, string, string]> = {
    normal: [OK, OK, NDEL],
    deleted: [DEL, DEL, OK],
    removed: [REM, REM, REM],
    // A lock stops new comments, not the author's own.
    onLocked: [OK, OK, NDEL],
    // A dead post takes no edit, but the author can still take their own comment back.
    onRemovedPost: [REM, OK, NDEL],
    onDeletedPost: [DEL, OK, NDEL],
    inRemovedCommunity: [CRM, CRM, CRM],
  };

  test.each(Object.entries(asAuthor))('the author acts on their comment: %s', async (state, expected) => {
    const commentId = world.comments.local[state as keyof typeof world.comments.local];
    const principal = localUser(world.people.reader.id);
    expect(await each(authorActions, (action) => act(action, principal, commentId))).toEqual(expected);
  });

  test('a remote author acts on their comment the same way', async () => {
    const principal = remote(world.people.remoteAuthor.id);
    expect(await each(authorActions, (action) => act(action, principal, world.comments.remote))).toEqual([OK, OK, NDEL]);
  });

  test.each([
    ['anonymous', anonymous, REQ],
    ['another local user', () => localUser(world.people.author.id), AUT],
    ['a community moderator', () => localUser(world.people.moderator.id), AUT],
    ['a site admin', () => admin(world.people.admin.id), AUT],
    ['a remote actor', () => remote(world.people.remoteAuthor.id), AUT],
    ['the instance itself', () => system(world.instances.local.id), REQ],
  ] as const)('nobody else acts on the comment: %s', async (_who, principal, refusal) => {
    const actual = await each(authorActions, (action) => act(action, principal(), world.comments.local.normal));
    expect(actual).toEqual([refusal, refusal, refusal]);
  });

  test('a comment that does not exist is target.not_found', async () => {
    const missing = '0192f5a0-1234-7abc-8def-0123456789ab';
    expect(await each(authorActions, (action) => act(action, localUser(world.people.reader.id), missing))).toEqual([NOT, NOT, NOT]);
  });

  test('an author banned from the community can delete their comment but not edit or restore it', async () => {
    const principal = localUser(world.people.banned.id);
    expect(await each(authorActions, (action) => act(action, principal, world.comments.banned))).toEqual([BAN, OK, BAN]);
  });
});
