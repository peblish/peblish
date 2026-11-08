import type { Principal } from '@peblish/schema/authz';
import { beforeAll, describe, expect, test } from 'vitest';
import type { Queryable } from '../db/read.ts';
import { policies } from '../registry/policies.gen.ts';
import { admin, seedModerationWorld, targetStates, type RemoteRowState, type Subject, type TargetState } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { authorize, type Decision } from './authorize.ts';
import type { ActionName } from './policy.ts';

// Role x action x target state: every combination's decision, allow or the exact refusal.
// Each role acts on a post (and its comment) in each state; 'community removed' is a normal
// post in a removed community. ban targets a member who is not banned, unban one who is.
// The whole table runs twice: as a precheck (no lock; the moderator cache may answer) and as
// a recheck inside a transaction (lock; the database alone answers).

type World = Awaited<ReturnType<typeof seedModerationWorld>>;
let world: World;
beforeAll(async () => {
  world = await seedModerationWorld();
});

const OK = 'allow';
const REQ = 'auth.required';
const MOD = 'mod.moderator_required';
const MIS = 'mod.announce_mismatch';
const BAN = 'community.banned';
const CRM = 'community.removed';
const DEL = 'target.deleted';
const REM = 'target.removed';
const NRM = 'target.not_removed';
const LCK = 'target.locked';
const NLK = 'target.not_locked';
const PIN = 'target.pinned';
const NPN = 'target.not_pinned';

type Options = { db?: Queryable; lock?: boolean };
type Column = { name: string; decide: (principal: Principal, subject: Subject, options: Options) => Promise<Decision<ActionName>> };

const columns: Column[] = [
  { name: 'post.create', decide: (p, s, o) => authorize('post.create', p, { communityId: s.communityId }, o) },
  { name: 'mod.remove post', decide: (p, s, o) => authorize('mod.remove', p, { target: { kind: 'post', id: s.postId } }, o) },
  { name: 'mod.restore post', decide: (p, s, o) => authorize('mod.restore', p, { target: { kind: 'post', id: s.postId } }, o) },
  { name: 'mod.remove comment', decide: (p, s, o) => authorize('mod.remove', p, { target: { kind: 'comment', id: s.commentId } }, o) },
  { name: 'mod.restore comment', decide: (p, s, o) => authorize('mod.restore', p, { target: { kind: 'comment', id: s.commentId } }, o) },
  { name: 'mod.lock', decide: (p, s, o) => authorize('mod.lock', p, { postId: s.postId }, o) },
  { name: 'mod.unlock', decide: (p, s, o) => authorize('mod.unlock', p, { postId: s.postId }, o) },
  { name: 'mod.pin', decide: (p, s, o) => authorize('mod.pin', p, { postId: s.postId }, o) },
  { name: 'mod.unpin', decide: (p, s, o) => authorize('mod.unpin', p, { postId: s.postId }, o) },
  {
    name: 'mod.ban',
    decide: (p, s, o) => authorize('mod.ban', p, { communityId: s.communityId, targetActorId: world.people.victim.id }, o),
  },
  {
    name: 'mod.unban',
    decide: (p, s, o) => authorize('mod.unban', p, { communityId: s.communityId, targetActorId: world.people.banned.id }, o),
  },
];

type Row = readonly string[];
type Expected = Record<TargetState, Row>;

/**
 * Who may moderate: the outcome follows the target's state. `post` is the post.create column,
 * and `removedPost` that column in a removed community.
 */
// prettier-ignore
const moderates = (post: string, removedPost = CRM): Expected => ({
  //                    post.create  remove  restore  remove   restore  lock  unlock  pin  unpin  ban  unban
  //                                 post    post     comment  comment
  normal:               [post,       OK,     NRM,     OK,      NRM,     OK,   NLK,    OK,  NPN,   OK,  OK],
  locked:               [post,       OK,     NRM,     OK,      NRM,     LCK,  OK,     OK,  NPN,   OK,  OK],
  pinned:               [post,       OK,     NRM,     OK,      NRM,     OK,   NLK,    PIN, OK,    OK,  OK],
  removed:              [post,       REM,    OK,      REM,     OK,      REM,  REM,    REM, REM,   OK,  OK],
  deleted:              [post,       DEL,    DEL,     DEL,     DEL,     DEL,  DEL,    DEL, DEL,   OK,  OK],
  'community removed':  [removedPost, CRM,   CRM,     CRM,     CRM,     CRM,  CRM,    CRM, CRM,   CRM, CRM],
});

/**
 * Who may not moderate: every mod.* column is `mod` whatever the target's state, and
 * `removedMod` in a removed community; post.create is `post`, and `removedPost` there.
 */
const refused = (post: string, mod: string, removedPost = CRM, removedMod = CRM): Expected => {
  const row = [post, ...Array<string>(10).fill(mod)];
  return {
    normal: row,
    locked: row,
    pinned: row,
    removed: row,
    deleted: row,
    'community removed': [removedPost, ...Array<string>(10).fill(removedMod)],
  };
};

type Role = { role: string; community: 'local' | 'remote'; principal: (subject: Subject) => Principal; expected: Expected };

/** A remote moderator acting directly (no Announce), its row in the given state. */
const remoteModerator = (state: RemoteRowState) => (): Principal => ({
  kind: 'remote',
  actorId: world.remoteModerators[state].id,
  announcedBy: null,
});

const roles: Role[] = [
  { role: 'anonymous', community: 'local', principal: () => ({ kind: 'anonymous' }), expected: refused(REQ, REQ, REQ, REQ) },
  { role: 'local user', community: 'local', principal: () => localUser(world.people.user.id), expected: refused(OK, MOD) },
  { role: 'author', community: 'local', principal: () => localUser(world.people.author.id), expected: refused(OK, MOD) },
  { role: 'community moderator', community: 'local', principal: () => localUser(world.people.moderator.id), expected: moderates(OK) },
  { role: 'expired moderator', community: 'local', principal: () => localUser(world.people.expired.id), expected: refused(OK, MOD) },
  { role: 'community owner', community: 'local', principal: () => localUser(world.people.owner.id), expected: moderates(OK) },
  { role: 'site admin', community: 'local', principal: () => admin(world.people.admin.id), expected: moderates(OK) },
  {
    role: 'remote actor, direct',
    community: 'local',
    principal: () => ({ kind: 'remote', actorId: world.people.remoteUser.id, announcedBy: null }),
    expected: refused(REQ, MOD, REQ),
  },
  {
    role: "remote actor, owning community's Announce",
    community: 'remote',
    principal: (s) => ({
      kind: 'remote',
      actorId: world.people.remoteUser.id,
      announcedBy: { communityId: s.communityId, announceApId: 'https://lemmy.test/activities/announce/1' },
    }),
    expected: moderates(REQ, REQ),
  },
  {
    role: "remote actor, another community's Announce",
    community: 'remote',
    principal: () => ({
      kind: 'remote',
      actorId: world.people.remoteUser.id,
      announcedBy: { communityId: world.elsewhere.id, announceApId: 'https://other.test/activities/announce/1' },
    }),
    expected: refused(REQ, MIS, REQ),
  },
  // Remote moderator rows (roles.ts: fresh). A local row with no expiry grants (community
  // moderator above); a remote one grants only once verified and before an expiry it must have.
  { role: 'remote moderator, unverified', community: 'remote', principal: remoteModerator('unverified'), expected: refused(REQ, MOD, REQ) },
  {
    role: 'remote moderator, verified, expired',
    community: 'remote',
    principal: remoteModerator('verified, expired'),
    expected: refused(REQ, MOD, REQ),
  },
  {
    role: 'remote moderator, verified, no expiry',
    community: 'remote',
    principal: remoteModerator('verified, no expiry'),
    expected: refused(REQ, MOD, REQ),
  },
  {
    role: 'remote moderator, verified, unexpired',
    community: 'remote',
    principal: remoteModerator('verified, unexpired'),
    expected: moderates(REQ, REQ),
  },
  { role: 'banned user', community: 'local', principal: () => localUser(world.people.banned.id), expected: refused(BAN, BAN) },
];

const outcome = (decision: Decision<ActionName>) => (decision.ok ? OK : decision.reason);

async function actual(role: Role, options: { lock: boolean }) {
  const rows: [TargetState, string[]][] = [];
  for (const state of targetStates) {
    const subject = world.subjects[role.community][state];
    const principal = role.principal(subject);
    const row: string[] = [];
    for (const { decide } of columns) {
      const decision = options.lock
        ? await tx((t) => decide(principal, subject, { db: t.db, lock: true }))
        : await decide(principal, subject, {});
      row.push(outcome(decision));
    }
    rows.push([state, row]);
  }
  return Object.fromEntries(rows);
}

describe.each([
  { mode: 'precheck', lock: false },
  { mode: 'recheck', lock: true },
])('$mode', ({ lock }) => {
  test.each(roles)('$role', async (role) => {
    expect(await actual(role, { lock })).toEqual(role.expected);
  });
});

test("the table has a column for post.create and every community mod.* policy (site bans are lane MODF's)", () => {
  const actions = Object.keys(policies).filter((action) => action.startsWith('mod.') && !action.startsWith('mod.site_'));
  expect(new Set(columns.map(({ name }) => name.split(' ')[0]))).toEqual(new Set(['post.create', ...actions]));
});
