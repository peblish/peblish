import type { Principal } from '@peblish/schema/authz';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { currentPrincipal } from '../authz/principal.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { readModlog } from '../modlog/read.ts';
import { banFromCommunity } from '../moderation/ban.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import {
  admin,
  gate,
  grantFor,
  outboxEvents,
  seedAdmin,
  seedComment,
  seedModerator,
  seedPost,
  someoneWaitsOnALock,
  writeCounts,
} from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { defineMutation } from '../tx/mutation.ts';
import { castVote } from '../votes/cast.ts';
import { tx } from '../tx/tx.ts';
import { banFromSite, unbanFromSite } from './site.ts';
import { siteBans } from './tables.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const andrew = await seedAdmin(local, 'Andrew');
  const second = await seedAdmin(local, 'Second');
  const member = await seedActor(local, 'Person', 'member');
  const moderator = await seedActor(local, 'Person', 'moderator');
  const spammer = await seedActor(local, 'Person', 'spammer');
  const gone = await seedActor(local, 'Person', 'gone', { deletedAt: new Date() });
  const banned = await seedActor(local, 'Person', 'banned');
  const instanceActor = await seedActor(local, 'Application', 'feddit.test');
  const technology = await seedActor(local, 'Group', 'technology');
  const lemmyAdmin = await seedActor(lemmy, 'Person', 'lemmy_admin');
  const lemmyUser = await seedActor(lemmy, 'Person', 'lemmy_user');
  const lemmyBanned = await seedActor(lemmy, 'Person', 'lemmy_banned');
  const piefedUser = await seedActor(piefed, 'Person', 'piefed_user');
  await seedModerator(technology, moderator);
  await writer()
    .insert(siteBans)
    .values([
      { actorId: banned.id, source: 'local', bannedBy: andrew.id },
      { actorId: lemmyBanned.id, source: 'remote', bannedBy: lemmyAdmin.id },
    ]);
  return {
    local,
    lemmy,
    andrew,
    second,
    member,
    moderator,
    spammer,
    gone,
    banned,
    instanceActor,
    technology,
    lemmyAdmin,
    lemmyUser,
    lemmyBanned,
    piefedUser,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const OK = 'allow';

/** The principal refresh, in a transaction as a rechecked write runs it. */
const asked = (principal: Parameters<typeof currentPrincipal>[1]) => tx((t) => currentPrincipal(t.db, principal));

/** One row per role: what each site policy answers for each target, as a precheck and as a recheck. */
describe('mod.site_ban and mod.site_unban: role by target state', () => {
  const targets: [string, (w: World) => string, Record<string, string>][] = [
    // ban, unban
    ['a member', (w) => w.spammer.id, { ban: OK, unban: 'target.not_site_banned' }],
    ['a banned person', (w) => w.banned.id, { ban: 'target.site_banned', unban: OK }],
    ['themselves', (w) => w.andrew.id, { ban: 'target.protected', unban: 'target.protected' }],
    ['another admin', (w) => w.second.id, { ban: 'target.protected', unban: 'target.protected' }],
    ['the instance actor', (w) => w.instanceActor.id, { ban: 'target.protected', unban: 'target.protected' }],
    ['a community', (w) => w.technology.id, { ban: 'target.not_found', unban: 'target.not_found' }],
    ['a deleted person', (w) => w.gone.id, { ban: 'target.deleted', unban: 'target.not_site_banned' }],
    ['a remote person', (w) => w.lemmyUser.id, { ban: OK, unban: 'target.not_site_banned' }],
    ['a banned remote person', (w) => w.lemmyBanned.id, { ban: 'target.site_banned', unban: OK }],
  ];
  const refusedRoles: [string, (w: World) => Principal, string][] = [
    ['anonymous', () => ({ kind: 'anonymous' }), 'auth.required'],
    ['a member', (w) => localUser(w.member.id), 'auth.admin_required'],
    ['a community moderator', (w) => localUser(w.moderator.id), 'auth.admin_required'],
    ['the instance', (w) => ({ kind: 'system', actorId: w.instanceActor.id, job: 'scheduled' }), 'auth.admin_required'],
    [
      'a remote person, announced',
      (w) => ({
        kind: 'remote',
        actorId: w.lemmyAdmin.id,
        announcedBy: { communityId: w.technology.id, announceApId: 'https://lemmy.test/a/1' },
      }),
      'mod.announce_mismatch',
    ],
  ];

  test.each(refusedRoles)('%s is refused whatever the target', async (_name, principal, reason) => {
    const w = await world();
    for (const [, target] of targets) {
      for (const lock of [false, true]) {
        for (const action of ['mod.site_ban', 'mod.site_unban'] as const) {
          const run = () => tx((t) => authorize(action, principal(w), { targetActorId: target(w) }, lock ? { db: t.db, lock } : {}));
          expect(await run()).toEqual({ ok: false, reason });
        }
      }
    }
  });

  test.each(targets)('an admin acting on %s', async (_name, target, expected) => {
    const w = await world();
    for (const lock of [false, true]) {
      const decide = (action: 'mod.site_ban' | 'mod.site_unban') =>
        tx((t) => authorize(action, admin(w.andrew.id), { targetActorId: target(w) }, lock ? { db: t.db, lock } : {}));
      const [ban, unban] = [await decide('mod.site_ban'), await decide('mod.site_unban')];
      expect(ban.ok ? OK : ban.reason, `ban lock=${lock}`).toBe(expected.ban);
      expect(unban.ok ? OK : unban.reason, `unban lock=${lock}`).toBe(expected.unban);
      if (ban.ok) expect(ban.grant.authority).toEqual({ kind: 'site-admin', actorId: w.andrew.id });
    }
  });

  test('an admin whose two-factor went away between authorize and the write is refused by the recheck', async () => {
    const w = await world();
    const grant = await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id });
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.name, 'Andrew'));
    const before = await writeCounts();
    await expect(banFromSite(grant, {})).rejects.toMatchObject({ name: 'Refused', reason: 'auth.admin_required' });
    expect(await writeCounts()).toEqual(before);
  });

  describe('a remote principal that is not announced', () => {
    test.each([
      ['its own person', (w: World) => w.lemmyUser.id, { ban: OK, unban: 'target.not_site_banned' }],
      ['its own banned person', (w: World) => w.lemmyBanned.id, { ban: 'target.site_banned', unban: OK }],
      ['a person of another instance', (w: World) => w.piefedUser.id, { ban: 'ban.origin_mismatch', unban: 'ban.origin_mismatch' }],
      ['one of our people', (w: World) => w.spammer.id, { ban: 'ban.not_remote', unban: 'ban.not_remote' }],
      ['itself', (w: World) => w.lemmyAdmin.id, { ban: 'target.protected', unban: 'target.protected' }],
      ['a community', (w: World) => w.technology.id, { ban: 'target.not_found', unban: 'target.not_found' }],
    ])('acting on %s', async (_name, target, expected) => {
      const w = await world();
      const principal: Principal = { kind: 'remote', actorId: w.lemmyAdmin.id, announcedBy: null };
      for (const lock of [false, true]) {
        for (const [action, key] of [
          ['mod.site_ban', 'ban'],
          ['mod.site_unban', 'unban'],
        ] as const) {
          const decision = await tx((t) => authorize(action, principal, { targetActorId: target(w) }, lock ? { db: t.db, lock } : {}));
          expect(decision.ok ? OK : decision.reason, `${action} lock=${lock}`).toBe(expected[key]);
          if (decision.ok) expect(decision.grant.authority).toEqual({ kind: 'owner', actorId: w.lemmyAdmin.id });
        }
      }
    });
  });

  test('an expired ban grants nothing: the person may be banned again, and the new ban replaces the row', async () => {
    const w = await world();
    await writer()
      .update(siteBans)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(siteBans.actorId, w.banned.id));
    const grant = await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.banned.id });
    await banFromSite(grant, { reason: 'Again' });
    const [row] = await db().select().from(siteBans).where(eq(siteBans.actorId, w.banned.id));
    expect(row).toMatchObject({ reason: 'Again', expiresAt: null, source: 'local' });
  });
});

describe('banFromSite and unbanFromSite', () => {
  test('a ban with removal removes the live content everywhere, writes one modlog row with the counts and emits one mod.ban', async () => {
    const w = await world();
    const other = await seedActor(w.local, 'Group', 'other');
    const mine = await seedPost(w.local, w.technology, w.spammer);
    const elsewhere = await seedPost(w.local, other, w.spammer);
    const deleted = await seedPost(w.local, other, w.spammer, { deletedAt: new Date(Date.now() - 1000) });
    const alreadyRemoved = await seedPost(w.local, other, w.spammer, { removedAt: new Date(Date.now() - 1000) });
    const untouched = await seedPost(w.local, w.technology, w.member);
    const comment = await seedComment(w.local, untouched, w.spammer);
    const answered = await seedComment(w.local, untouched, w.member);
    const result = await banFromSite(await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id }), {
      reason: 'Spam',
      removeContent: true,
      public: true,
    });
    expect(result.removed).toEqual({ posts: 2, comments: 1 });
    const removedAt = async (table: typeof posts | typeof comments, id: string) =>
      (await db().select({ at: table.removedAt }).from(table).where(eq(table.id, id)))[0]!.at;
    expect(await removedAt(posts, mine.id)).toBeInstanceOf(Date);
    expect(await removedAt(posts, elsewhere.id)).toBeInstanceOf(Date);
    expect(await removedAt(posts, untouched.id)).toBeNull();
    expect(await removedAt(posts, deleted.id)).toBeNull();
    expect((await removedAt(posts, alreadyRemoved.id))!.getTime()).toBeLessThan(Date.now() - 500);
    expect(await removedAt(comments, comment.id)).toBeInstanceOf(Date);
    expect(await removedAt(comments, answered.id)).toBeNull();
    expect(await db().select().from(siteBans).where(eq(siteBans.actorId, w.spammer.id))).toMatchObject([
      { source: 'local', reason: 'Spam', removeContent: true, bannedBy: w.andrew.id, expiresAt: null },
    ]);

    const log = await readModlog({}, { audience: 'public' });
    expect(log).toMatchObject([
      {
        id: result.modlogId,
        action: 'mod.site_ban',
        communityId: null,
        targetActorId: w.spammer.id,
        reason: 'Spam',
        authority: { kind: 'site-admin', actorId: w.andrew.id },
        details: { removeContent: true, removedPosts: 2, removedComments: 1, expiresAt: null },
      },
    ]);
    expect(await outboxEvents()).toEqual([
      {
        type: 'mod.ban',
        v: 1,
        modlogId: result.modlogId,
        moderatorId: w.andrew.id,
        local: true,
        targetActorId: w.spammer.id,
        targetApId: w.spammer.apId,
        communityId: null,
        banned: true,
        removeContent: true,
        expiresAt: null,
        reason: 'Spam',
      },
    ]);
  });

  test('a ban without removal keeps the content; an unban deletes the row, restores nothing and is logged beside the ban', async () => {
    const w = await world();
    const post = await seedPost(w.local, w.technology, w.spammer);
    const ban = await banFromSite(await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id }), {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      public: false,
    });
    expect((await db().select().from(posts).where(eq(posts.id, post.id)))[0]!.removedAt).toBeNull();
    const unban = await unbanFromSite(await grantFor('mod.site_unban', admin(w.andrew.id), { targetActorId: w.spammer.id }), {
      reason: 'Appeal',
    });
    expect(await db().select().from(siteBans).where(eq(siteBans.actorId, w.spammer.id))).toEqual([]);
    expect((await readModlog({}, { audience: 'staff' })).map((entry) => [entry.id, entry.action, entry.public])).toEqual([
      [unban.modlogId, 'mod.site_unban', true],
      [ban.modlogId, 'mod.site_ban', false],
    ]);
    expect(await outboxEvents()).toMatchObject([
      { banned: true, communityId: null },
      { banned: false, communityId: null },
    ]);
  });

  test('a ban that is not in the future is refused and writes nothing', async () => {
    const w = await world();
    const grant = await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id });
    const before = await writeCounts();
    await expect(banFromSite(grant, { expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(RangeError);
    expect(await writeCounts()).toEqual(before);
    expect(await db().select().from(siteBans).where(eq(siteBans.actorId, w.spammer.id))).toEqual([]);
  });

  test('a peer bans its own person: source remote, owner authority, the event is not local', async () => {
    const w = await world();
    const principal: Principal = { kind: 'remote', actorId: w.lemmyAdmin.id, announcedBy: null };
    const post = await seedPost(w.lemmy, await seedActor(w.lemmy, 'Group', 'rem'), w.lemmyUser);
    await banFromSite(await grantFor('mod.site_ban', principal, { targetActorId: w.lemmyUser.id }), {
      removeContent: true,
      activityApId: 'https://lemmy.test/activities/block/1',
      reason: 'Spam',
    });
    expect(await db().select().from(siteBans).where(eq(siteBans.actorId, w.lemmyUser.id))).toMatchObject([
      { source: 'remote', activityApId: 'https://lemmy.test/activities/block/1', bannedBy: w.lemmyAdmin.id, removeContent: true },
    ]);
    expect((await db().select().from(posts).where(eq(posts.id, post.id)))[0]!.removedAt).toBeInstanceOf(Date);
    expect(await outboxEvents()).toMatchObject([{ type: 'mod.ban', local: false, communityId: null, moderatorId: w.lemmyAdmin.id }]);
    const [entry] = await readModlog({}, { audience: 'staff' });
    expect(entry).toMatchObject({ authority: { kind: 'owner', actorId: w.lemmyAdmin.id } });
  });
});

describe('the principal refresh', () => {
  test('a site-banned person keeps their session and reads, and every rechecked write is refused with auth.site_banned', async () => {
    const w = await world();
    await banFromSite(await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id }), {});
    // The precheck does not read the ban: the grant is issued, the write refuses it.
    const grant = await grantFor('post.create', localUser(w.spammer.id), { communityId: w.technology.id });
    await expect(createPost(grant, { title: 'Buy now' })).rejects.toMatchObject({ name: 'Refused', reason: 'auth.site_banned' });
    expect(await db().select({ id: posts.id }).from(posts)).toEqual([]);
    expect(await asked(localUser(w.spammer.id))).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect(await asked({ kind: 'remote', actorId: w.lemmyBanned.id, announcedBy: null })).toEqual({
      ok: false,
      reason: 'auth.site_banned',
    });
  });

  test('an unbanned person, a person whose ban ended and the instance itself are not refused', async () => {
    const w = await world();
    await writer()
      .update(siteBans)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(siteBans.actorId, w.banned.id));
    expect(await asked(localUser(w.banned.id))).toMatchObject({ ok: true });
    expect(await asked(localUser(w.member.id))).toMatchObject({ ok: true });
    expect(await asked({ kind: 'system', actorId: w.instanceActor.id, job: 'scheduled' })).toMatchObject({ ok: true });
  });
});

describe('a site ban is an INSERT: the target actor row orders it against the target’s rechecked writes', () => {
  async function setup() {
    const w = await world();
    const postGrant = await grantFor('post.create', localUser(w.spammer.id), { communityId: w.technology.id });
    const banGrant = await grantFor('mod.site_ban', admin(w.andrew.id), { targetActorId: w.spammer.id });
    return { w, postGrant, banGrant };
  }

  test('the post rechecks first: the ban waits for the post to commit, then removes it', async () => {
    const { postGrant, banGrant } = await setup();
    const rechecked = gate();
    const release = gate();
    const slowCreate = defineMutation({
      action: 'post.create',
      emits: ['post.created'],
      recheck: true,
      async run(t, g, _input: null) {
        rechecked.open();
        await release.opened;
        const post = await createPost.within(t, g, { title: 'Just in time' });
        return post;
      },
    });
    const order: string[] = [];
    const post = slowCreate(postGrant, null).then(() => order.push('post committed'));
    await rechecked.opened;
    const ban = banFromSite(banGrant, { removeContent: true }).then((result) => {
      order.push('ban committed');
      return result;
    });
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      expect(order).toEqual([]);
    } finally {
      release.open();
    }
    const [, result] = await Promise.all([post, ban]);
    expect(order).toEqual(['post committed', 'ban committed']);
    expect(result.removed.posts).toBe(1);
  });

  test("the ban commits first: the post's recheck refuses with auth.site_banned and writes nothing", async () => {
    const { postGrant, banGrant } = await setup();
    await banFromSite(banGrant, {});
    await expect(createPost(postGrant, { title: 'Too late' })).rejects.toMatchObject({ reason: 'auth.site_banned' });
    expect(await db().select({ id: posts.id }).from(posts)).toEqual([]);
  });

  test('a site ban, a community ban and a vote by the target at once all finish; none deadlocks', async () => {
    const { w, banGrant } = await setup();
    await seedModerator(w.technology, w.member);
    const post = await seedPost(w.local, w.technology, w.member);
    const voteGrant = await grantFor('vote.cast', localUser(w.spammer.id), { target: { kind: 'post', id: post.id } });
    const communityBan = await grantFor('mod.ban', localUser(w.member.id), { communityId: w.technology.id, targetActorId: w.spammer.id });
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([
        banFromSite(banGrant, { removeContent: true }),
        banFromCommunity(communityBan, { removeContent: true }),
        castVote(voteGrant, { value: 1 }),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ name: 'Refused' });
      }
      await unbanFromSite(await grantFor('mod.site_unban', admin(w.andrew.id), { targetActorId: w.spammer.id }), {}).catch(() => {});
    }
  });
});
