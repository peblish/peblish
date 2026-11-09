import type { Principal } from '@peblish/schema/authz';
import { beforeAll, describe, expect, test } from 'vitest';
import { authorize, type Decision } from '../authz/authorize.ts';
import type { ActionName } from '../authz/policy.ts';
import type { Queryable } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedPostWorld, postStates, type PostState } from '../testing/seed-b1.ts';
import { seedComment } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';

// The policy table of the post and vote actions: every principal against every community or
// post state, allow or the exact refusal, as a precheck (no lock) and as a recheck (inside the
// transaction, with the principal re-read and every row locked).

type World = Awaited<ReturnType<typeof seedPostWorld>>;
let world: World;
let commentOnNormalPost: string;
beforeAll(async () => {
  await truncateAll();
  world = await seedPostWorld();
  commentOnNormalPost = (await seedComment(world.instances.local, { id: world.posts.local.normal }, world.people.author)).id;
});

const OK = 'allow';
const REQ = 'auth.required';
const UNV = 'auth.email_unverified';
const RST = 'community.posting_restricted';
const BAN = 'community.banned';
const CRM = 'community.removed';
const MIS = 'mod.announce_mismatch';
const GRP = 'post.group_cannot_act';
const AUT = 'post.author_required';
const NDL = 'post.not_deleted';
const DEL = 'target.deleted';
const REM = 'target.removed';

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

describe.each([
  { mode: 'precheck', lock: false },
  { mode: 'recheck', lock: true },
])('$mode', ({ lock }) => {
  const columns = ['open', 'restricted', 'removed', 'remote', 'remoteRestricted'] as const;
  type Community = (typeof columns)[number];
  const create = (principal: Principal, community: Community) =>
    run(lock, async (options) =>
      outcome(await authorize('post.create', principal, { communityId: world.communities[community].id }, options)),
    );

  // prettier-ignore
  const creates: { who: string; principal: () => Principal; expected: Record<Community, string> }[] = [
    //                                                                                  open  restricted removed remote remoteRestricted
    { who: 'anonymous',                  principal: anonymous,                                    expected: { open: REQ, restricted: REQ, removed: REQ, remote: REQ, remoteRestricted: REQ } },
    { who: 'unverified email',           principal: () => localUser(world.people.unverified.id),  expected: { open: UNV, restricted: UNV, removed: UNV, remote: UNV, remoteRestricted: UNV } },
    { who: 'local user',                 principal: () => localUser(world.people.reader.id),      expected: { open: OK,  restricted: RST, removed: CRM, remote: OK,  remoteRestricted: RST } },
    { who: 'author',                     principal: () => localUser(world.people.author.id),      expected: { open: OK,  restricted: RST, removed: CRM, remote: OK,  remoteRestricted: RST } },
    { who: 'community moderator',        principal: () => localUser(world.people.moderator.id),   expected: { open: OK,  restricted: OK,  removed: CRM, remote: OK,  remoteRestricted: RST } },
    { who: 'community owner',            principal: () => localUser(world.people.owner.id),       expected: { open: OK,  restricted: OK,  removed: CRM, remote: OK,  remoteRestricted: RST } },
    { who: 'site admin',                 principal: () => admin(world.people.admin.id),           expected: { open: OK,  restricted: OK,  removed: CRM, remote: OK,  remoteRestricted: OK } },
    { who: 'banned from open',           principal: () => localUser(world.people.banned.id),      expected: { open: BAN, restricted: RST, removed: CRM, remote: OK,  remoteRestricted: RST } },
    { who: 'remote author, direct',      principal: () => remote(world.people.remoteAuthor.id),   expected: { open: OK,  restricted: RST, removed: CRM, remote: OK,  remoteRestricted: OK } },
    { who: 'remote community, direct',   principal: () => remote(world.communities.remote.id),   expected: { open: GRP, restricted: GRP, removed: GRP, remote: GRP, remoteRestricted: GRP } },
    {
      who: 'remote community acting as itself',
      principal: () => remote(world.communities.remote.id, { communityId: world.communities.remote.id }),
      expected: { open: GRP, restricted: GRP, removed: GRP, remote: GRP, remoteRestricted: GRP },
    },
    {
      who: "remote author, the remote community's Announce",
      principal: () => remote(world.people.remoteAuthor.id, { communityId: world.communities.remote.id }),
      expected: { open: MIS, restricted: MIS, removed: CRM, remote: OK, remoteRestricted: MIS },
    },
  ];

  test.each(creates)('post.create: $who', async ({ principal, expected }) => {
    const actual = Object.fromEntries(await each(columns, async (column) => [column, await create(principal(), column)] as const));
    expect(actual).toEqual(expected);
  });

  const authorActions = ['post.update', 'post.delete', 'post.restore'] as const;
  const act = (action: (typeof authorActions)[number], principal: Principal, postId: string) =>
    run(lock, async (options) => outcome(await authorize(action, principal, { postId }, options)));

  // The author's own posts in each state; update, delete, restore.
  // prettier-ignore
  const asAuthor: Record<PostState, [string, string, string]> = {
    normal:               [OK,  OK,  NDL],
    locked:               [OK,  OK,  NDL],
    removed:              [REM, REM, REM],
    deleted:              [DEL, DEL, OK],
    'community removed':  [CRM, CRM, CRM],
  };

  test.each(postStates)('the author acts on their post: %s', async (state) => {
    const principal = localUser(world.people.author.id);
    const actual = await each(authorActions, (action) => act(action, principal, world.posts.local[state]));
    expect(actual).toEqual(asAuthor[state]);
  });

  test.each(postStates)('a remote author acts on their post the same way: %s', async (state) => {
    const principal = remote(world.people.remoteAuthor.id);
    const actual = await each(authorActions, (action) => act(action, principal, world.posts.remote[state]));
    expect(actual).toEqual(asAuthor[state]);
  });

  test.each([
    ['anonymous', anonymous, REQ],
    ['another local user', () => localUser(world.people.reader.id), AUT],
    ['unverified email, not the author', () => localUser(world.people.unverified.id), AUT],
    ['a community moderator', () => localUser(world.people.moderator.id), AUT],
    ['a site admin', () => admin(world.people.admin.id), AUT],
    ['a remote actor', () => remote(world.people.remoteAuthor.id), AUT],
  ] as const)('nobody else acts on the post: %s', async (_who, principal, refusal) => {
    const actual = await each(authorActions, (action) => act(action, principal(), world.posts.local.normal));
    expect(actual).toEqual([refusal, refusal, refusal]);
  });

  test.each([
    ['direct', () => remote(world.communities.remote.id)],
    ['acting as itself', () => remote(world.communities.remote.id, { communityId: world.communities.remote.id })],
  ] as const)('a remote community does not act on posts, even its own: %s', async (_how, principal) => {
    const actual = await each(authorActions, (action) => act(action, principal(), world.posts.remote.normal));
    expect(actual).toEqual([GRP, GRP, GRP]);
  });

  test('a post that does not exist is target.not_found', async () => {
    const principal = localUser(world.people.author.id);
    const missing = '0192f5a0-1234-7abc-8def-0123456789ab';
    expect(await each(authorActions, (action) => act(action, principal, missing))).toEqual(Array(3).fill('target.not_found'));
  });

  test('an author banned from the community can delete their post but not edit or restore it', async () => {
    const principal = localUser(world.people.banned.id);
    expect(await each(authorActions, (action) => act(action, principal, world.posts.banned))).toEqual([BAN, OK, BAN]);
  });

  const targets = {
    'a post': () => ({ kind: 'post', id: world.posts.local.normal }) as const,
    'a post, locked': () => ({ kind: 'post', id: world.posts.local.locked }) as const,
    'a post, removed': () => ({ kind: 'post', id: world.posts.local.removed }) as const,
    'a post, deleted': () => ({ kind: 'post', id: world.posts.local.deleted }) as const,
    'a post, community removed': () => ({ kind: 'post', id: world.posts.local['community removed'] }) as const,
    'a comment': () => ({ kind: 'comment', id: commentOnNormalPost }) as const,
  };
  const vote = (principal: Principal, target: keyof typeof targets) =>
    run(lock, async (options) => outcome(await authorize('vote.cast', principal, { target: targets[target]() }, options)));

  // prettier-ignore
  const votes: { who: string; principal: () => Principal; expected: Record<keyof typeof targets, string> }[] = [
    { who: 'anonymous',        principal: anonymous,                                   expected: { 'a post': REQ, 'a post, locked': REQ, 'a post, removed': REQ, 'a post, deleted': REQ, 'a post, community removed': REQ, 'a comment': REQ } },
    { who: 'local user',       principal: () => localUser(world.people.reader.id),     expected: { 'a post': OK,  'a post, locked': OK,  'a post, removed': REM, 'a post, deleted': DEL, 'a post, community removed': CRM, 'a comment': OK } },
    { who: 'unverified email', principal: () => localUser(world.people.unverified.id), expected: { 'a post': OK,  'a post, locked': OK,  'a post, removed': REM, 'a post, deleted': DEL, 'a post, community removed': CRM, 'a comment': OK } },
    { who: 'the author',       principal: () => localUser(world.people.author.id),     expected: { 'a post': OK,  'a post, locked': OK,  'a post, removed': REM, 'a post, deleted': DEL, 'a post, community removed': CRM, 'a comment': OK } },
    { who: 'banned',           principal: () => localUser(world.people.banned.id),     expected: { 'a post': BAN, 'a post, locked': BAN, 'a post, removed': BAN, 'a post, deleted': BAN, 'a post, community removed': CRM, 'a comment': BAN } },
    { who: 'remote voter',     principal: () => remote(world.people.remoteAuthor.id),  expected: { 'a post': OK,  'a post, locked': OK,  'a post, removed': REM, 'a post, deleted': DEL, 'a post, community removed': CRM, 'a comment': OK } },
    { who: 'remote community', principal: () => remote(world.communities.remote.id),    expected: { 'a post': GRP, 'a post, locked': GRP, 'a post, removed': GRP, 'a post, deleted': GRP, 'a post, community removed': GRP, 'a comment': GRP } },
  ];

  test.each(votes)('vote.cast: $who', async ({ principal, expected }) => {
    const names = Object.keys(targets) as (keyof typeof targets)[];
    const actual = Object.fromEntries(await each(names, async (name) => [name, await vote(principal(), name)] as const));
    expect(actual).toEqual(expected);
  });
});
