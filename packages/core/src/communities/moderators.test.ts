import type { Principal } from '@peblish/schema/authz';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { moderatorCache } from '../authz/moderators-cache.ts';
import { db } from '../db/read.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { outbox } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { readModlog } from '../modlog/read.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedBan, seedCommunityRemoval, seedModerator, seedPost } from '../testing/seed-az.ts';
import { person, remote, seedCommunityWorld } from '../testing/seed-f.ts';
import { seedActor } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { createCommunityAs } from './create.ts';
import { setModerator, setModeratorAs } from './moderators.ts';
import { updateCommunityAs } from './update.ts';

beforeEach(async () => {
  await truncateAll();
  moderatorCache().clear();
});

/** A community by the admin, with `member` as a second owner and `moderator` as a moderator. */
async function setup() {
  const world = await seedCommunityWorld();
  const { instances, people } = world;
  const admin = person(people.admin.id, 'admin');
  const made = await createCommunityAs(admin, { name: 'news' });
  if (!made.ok) throw new Error(made.reason);
  const community = { id: made.id };
  await seedModerator(community, people.member, { role: 'owner' });
  await seedModerator(community, people.moderator);
  await writer().delete(outbox); // the create's event is not under test here
  return { ...world, admin, community, owner: person(people.member.id), moderator: person(people.moderator.id), instances };
}

const roleOf = async (communityId: string, actorId: string) =>
  (
    await db()
      .select({ role: communityModerators.role })
      .from(communityModerators)
      .where(and(eq(communityModerators.communityId, communityId), eq(communityModerators.moderatorId, actorId)))
  )[0]?.role ?? null;

describe('community.set_moderator policy', () => {
  test('the owner and a site admin are allowed; a moderator, a user and the rest get the exact reason', async () => {
    const { people, admin, owner, moderator, community } = await setup();
    const subject = { communityId: community.id, actorId: people.other.id, role: 'moderator' } as const;
    const refused: [string, Principal, string][] = [
      ['anonymous', { kind: 'anonymous' }, 'auth.required'],
      ['a moderator', moderator, 'community.owner_required'],
      ['a local user', person(people.user.id), 'community.owner_required'],
      ['an admin without two-factor, as the session reports it', person(people.adminWithoutTwoFactor.id), 'community.owner_required'],
      ['a remote actor', remote(people.remoteUser.id), 'auth.required'],
    ];
    for (const [who, principal, reason] of refused)
      expect(await authorize('community.set_moderator', principal, subject), who).toEqual({ ok: false, reason });
    expect(await authorize('community.set_moderator', owner, subject)).toMatchObject({
      ok: true,
      grant: { authority: { kind: 'local-role', actorId: people.member.id, role: 'owner', communityId: community.id } },
    });
    expect(await authorize('community.set_moderator', admin, subject)).toMatchObject({
      ok: true,
      grant: { authority: { kind: 'site-admin', actorId: people.admin.id } },
    });
  });

  test('the community must be live and local, and a banned owner is refused', async () => {
    const { instances, people, owner, admin, community } = await setup();
    const technology = await seedActor(instances.lemmy, 'Group', 'technology');
    const deleted = await seedActor(instances.local, 'Group', 'gone', { deletedAt: new Date() });
    const removed = await seedActor(instances.local, 'Group', 'closed');
    await seedCommunityRemoval(removed);
    const table: [string, string, string][] = [
      ['a remote community', technology.id, 'community.not_local'],
      ['a deleted community', deleted.id, 'community.deleted'],
      ['a removed community', removed.id, 'community.removed'],
      ['a Person', people.user.id, 'target.not_found'],
    ];
    for (const [what, communityId, reason] of table) {
      expect(await authorize('community.set_moderator', admin, { communityId, actorId: people.other.id, role: 'moderator' }), what).toEqual(
        { ok: false, reason },
      );
    }
    await seedBan(community, people.member);
    expect(
      await authorize('community.set_moderator', owner, { communityId: community.id, actorId: people.other.id, role: 'moderator' }),
    ).toEqual({
      ok: false,
      reason: 'community.banned',
    });
  });

  test('targets: a live Person other than the actor, not banned when appointed, and the role must change', async () => {
    const { instances, people, admin, owner, community } = await setup();
    const instanceActor = await seedActor(instances.local, 'Application', 'feddit.test');
    const technology = await seedActor(instances.lemmy, 'Group', 'technology');
    const gone = await seedActor(instances.local, 'Person', 'gone', { deletedAt: new Date() });
    const banned = await seedActor(instances.local, 'Person', 'banned');
    await seedBan(community, banned);
    const expired = await seedActor(instances.local, 'Person', 'expired');
    await seedModerator(community, expired, { expiresAt: new Date(Date.now() - 60_000) });
    const missing = '0198f3a2-0000-7000-8000-000000000000';
    const table: [string, Principal, string, 'owner' | 'moderator' | null, string | null][] = [
      ['the admin themself', admin, people.admin.id, 'moderator', 'target.protected'],
      ['the owner themself, so the last owner stays', owner, people.member.id, null, 'target.protected'],
      ['the instance actor', admin, instanceActor.id, 'moderator', 'target.protected'],
      ['a Group', admin, technology.id, 'moderator', 'target.not_found'],
      ['no such actor', admin, missing, 'moderator', 'target.not_found'],
      ['a deleted person', admin, gone.id, 'moderator', 'target.deleted'],
      ['a banned person, appointed', admin, banned.id, 'moderator', 'target.banned'],
      ['a moderator, made a moderator again', admin, people.moderator.id, 'moderator', 'community.role_unchanged'],
      ['an owner, made an owner again', admin, people.member.id, 'owner', 'community.role_unchanged'],
      ['a user who is no moderator, removed', admin, people.user.id, null, 'community.role_unchanged'],
      ['a person whose moderator row expired, appointed', admin, expired.id, 'moderator', null],
      ['a person whose moderator row expired, removed', admin, expired.id, null, 'community.role_unchanged'],
      ['a remote person, appointed', owner, people.remoteUser.id, 'moderator', null],
      ['a moderator, promoted', owner, people.moderator.id, 'owner', null],
      ['a moderator, removed', owner, people.moderator.id, null, null],
    ];
    for (const [what, principal, actorId, role, reason] of table) {
      const decision = await authorize('community.set_moderator', principal, { communityId: community.id, actorId, role });
      expect(decision.ok ? null : decision.reason, what).toBe(reason);
    }
  });
});

describe('community.set_moderator', () => {
  test('appoints, promotes and removes; each change is logged, emitted as mod.role and takes effect for the moderation actions', async () => {
    const { instances, people, admin, owner, community } = await setup();
    const post = await seedPost(instances.local, community, people.user);
    const lock = () => authorize('mod.lock', person(people.other.id), { postId: post.id });
    expect(await lock()).toEqual({ ok: false, reason: 'mod.moderator_required' });

    const appointed = await setModeratorAs(
      owner,
      { communityId: community.id, actorId: people.other.id, role: 'moderator' },
      { reason: 'Welcome aboard' },
    );
    expect(appointed).toMatchObject({ ok: true });
    expect(await roleOf(community.id, people.other.id)).toBe('moderator');
    const [row] = await db().select().from(communityModerators).where(eq(communityModerators.moderatorId, people.other.id));
    expect(row).toMatchObject({ source: 'local', expiresAt: null });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(await lock()).toMatchObject({ ok: true });

    const promoted = await setModeratorAs(owner, { communityId: community.id, actorId: people.other.id, role: 'owner' });
    expect(await roleOf(community.id, people.other.id)).toBe('owner');
    expect(
      await authorize('community.set_moderator', person(people.other.id), {
        communityId: community.id,
        actorId: people.moderator.id,
        role: null,
      }),
    ).toMatchObject({ ok: true });

    // The web process forgets the removed role at once; without that its cache would keep granting the precheck for up to a minute.
    const removed = await setModeratorAs(admin, { communityId: community.id, actorId: people.other.id, role: null });
    expect(await roleOf(community.id, people.other.id)).toBeNull();
    expect(await lock()).toEqual({ ok: false, reason: 'mod.moderator_required' });

    if (!appointed.ok || !promoted.ok || !removed.ok) throw new Error('a change was refused');
    const log = await readModlog({ communityId: community.id }, { audience: 'public' });
    expect(log.map(({ id, action, actorId, targetActorId, reason }) => ({ id, action, actorId, targetActorId, reason }))).toEqual([
      { id: removed.modlogId, action: 'community.set_moderator', actorId: people.admin.id, targetActorId: people.other.id, reason: null },
      { id: promoted.modlogId, action: 'community.set_moderator', actorId: people.member.id, targetActorId: people.other.id, reason: null },
      {
        id: appointed.modlogId,
        action: 'community.set_moderator',
        actorId: people.member.id,
        targetActorId: people.other.id,
        reason: 'Welcome aboard',
      },
    ]);
    expect(log[2]?.authority).toEqual({ kind: 'local-role', actorId: people.member.id, role: 'owner', communityId: community.id });
    const event = { type: 'mod.role', v: 1, local: true, communityId: community.id, actorId: people.other.id };
    expect(await outboxEvents()).toEqual([
      { ...event, modlogId: appointed.modlogId, moderatorId: people.member.id, role: 'moderator' },
      { ...event, modlogId: promoted.modlogId, moderatorId: people.member.id, role: 'owner' },
      { ...event, modlogId: removed.modlogId, moderatorId: people.admin.id, role: null },
    ]);
  });

  test('an owner demoted after authorize() is refused by the recheck, with nothing written', async () => {
    const { people, owner, community } = await setup();
    const grant = await grantFor('community.set_moderator', owner, {
      communityId: community.id,
      actorId: people.other.id,
      role: 'moderator',
    });
    await writer().delete(communityModerators).where(eq(communityModerators.moderatorId, people.member.id));
    await expect(setModerator(grant, {})).rejects.toThrowError(new Refused('community.set_moderator', 'community.owner_required'));
    expect(await roleOf(community.id, people.other.id)).toBeNull();
    expect(await outboxEvents()).toEqual([]);
  });

  test('edits and role changes of one community at once take turns, and none deadlocks', async () => {
    const { people, admin, owner, moderator, community } = await setup();
    const { id: communityId } = community;
    const results = await Promise.all([
      updateCommunityAs(moderator, communityId, { displayName: 'A' }),
      updateCommunityAs(owner, communityId, { displayName: 'B' }),
      updateCommunityAs(admin, communityId, { postingRestrictedToMods: true }),
      setModeratorAs(owner, { communityId, actorId: people.moderator.id, role: null }),
      setModeratorAs(admin, { communityId, actorId: people.other.id, role: 'moderator' }),
      setModeratorAs(owner, { communityId, actorId: people.other.id, role: 'owner' }),
      setModeratorAs(admin, { communityId, actorId: people.moderator.id, role: 'owner' }),
    ]);
    // A refusal is a result (the order decides which); a deadlock (40P01) would have thrown.
    expect(results.filter((result) => result.ok).length).toBeGreaterThanOrEqual(3);
  });

  test('the instance itself cannot appoint moderators', async () => {
    const { instances, people, community } = await setup();
    const instanceActor = await seedActor(instances.local, 'Application', 'feddit.test');
    const principal: Principal = { kind: 'system', actorId: instanceActor.id, job: 'import' };
    expect(
      await authorize('community.set_moderator', principal, { communityId: community.id, actorId: people.other.id, role: 'moderator' }),
    ).toEqual({
      ok: false,
      reason: 'auth.required',
    });
  });
});
