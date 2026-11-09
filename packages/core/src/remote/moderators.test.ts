import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { freshModerator } from '../authz/roles.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { communityModerators, modlog } from '../db/tables/moderation.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedModerator } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { communitiesDueForMirror, mirrorModerators, moderatorsTtlMs, refreshWithinMs } from './moderators.ts';

const collection = 'https://lemmy.test/c/lab/moderators';

async function world() {
  const local = await seedLocalInstance();
  const lemmy = await seedInstance('lemmy.test', false);
  const lab = await seedActor(lemmy, 'Group', 'lab', { apId: 'https://lemmy.test/c/lab', moderatorsUrl: collection });
  const [ann, bea, cy] = await Promise.all(['ann', 'bea', 'cy'].map((name) => seedActor(lemmy, 'Person', name)));
  const mirror = async (moderatorIds: string[], communityId = lab.id) => {
    const decision = await authorize('remote.moderators_mirror', await local.importer(), { communityId });
    if (!decision.ok) throw new Error(decision.reason);
    return mirrorModerators(decision.grant, { moderatorIds, collection });
  };
  const rows = async () => db().select().from(communityModerators).where(eq(communityModerators.communityId, lab.id));
  return { ...local, lemmy, lab, ann: ann!, bea: bea!, cy: cy!, mirror, rows };
}

const roleEvents = async () =>
  (await outboxEvents()).filter((event) => (event as { type: string }).type === 'mod.role') as unknown as {
    actorId: string;
    role: string | null;
    local: boolean;
  }[];

beforeEach(truncateAll);

describe('mirroring a remote community’s moderators', () => {
  test('adds the listed, confirms the kept, removes the dropped, each change a mod.role event and a non-public modlog row', async () => {
    const w = await world();
    expect(await w.mirror([w.ann.id, w.bea.id])).toEqual({ added: 2, removed: 0, confirmed: 0 });
    const first = await w.rows();
    expect(first.map((row) => row.moderatorId).sort()).toEqual([w.ann.id, w.bea.id].sort());
    for (const row of first) {
      expect(row).toMatchObject({ source: 'remote', role: 'moderator' });
      expect(row.verifiedAt).toBeInstanceOf(Date);
      expect((row.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(moderatorsTtlMs - 60_000);
    }

    expect(await w.mirror([w.bea.id, w.cy.id])).toEqual({ added: 1, removed: 1, confirmed: 1 });
    expect((await w.rows()).map((row) => row.moderatorId).sort()).toEqual([w.bea.id, w.cy.id].sort());

    const events = await roleEvents();
    expect(events.map((event) => [event.actorId, event.role])).toEqual([
      [w.ann.id, 'moderator'],
      [w.bea.id, 'moderator'],
      [w.cy.id, 'moderator'],
      [w.ann.id, null],
    ]);
    expect(events.every((event) => event.local === false)).toBe(true);
    const log = await db().select().from(modlog);
    expect(log).toHaveLength(4);
    expect(log.every((row) => row.public === false && row.communityId === w.lab.id)).toBe(true);
  });

  test('a list that did not change writes nothing but the new expiry', async () => {
    const w = await world();
    await w.mirror([w.ann.id]);
    const [before] = await w.rows();
    await w.mirror([w.ann.id]);
    const [after] = await w.rows();
    expect(after!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before!.expiresAt!.getTime());
    expect(await roleEvents()).toHaveLength(1);
    expect(await db().select().from(modlog)).toHaveLength(1);
  });

  test('a row that was never confirmed or has expired grants nothing; a mirrored one does until it runs out', async () => {
    const w = await world();
    await w.mirror([w.ann.id]);
    const granting = async (id: string) =>
      (
        await db()
          .select({ id: communityModerators.moderatorId })
          .from(communityModerators)
          .where(and(eq(communityModerators.moderatorId, id), freshModerator))
      ).length;
    expect(await granting(w.ann.id)).toBe(1);
    await writer()
      .update(communityModerators)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(communityModerators.moderatorId, w.ann.id));
    expect(await granting(w.ann.id)).toBe(0);
    // The next mirror confirms it again.
    await w.mirror([w.ann.id]);
    expect(await granting(w.ann.id)).toBe(1);
  });

  test('rows a local owner appointed are left alone, listed or not; a missing or deleted person is not mirrored', async () => {
    const w = await world();
    await seedModerator(w.lab, w.cy);
    await w.mirror([w.ann.id]);
    expect((await w.rows()).find((row) => row.moderatorId === w.cy.id)).toMatchObject({ source: 'local' });
    await w.mirror([w.cy.id]);
    expect((await w.rows()).find((row) => row.moderatorId === w.cy.id)).toMatchObject({ source: 'local' });
    expect((await w.rows()).find((row) => row.moderatorId === w.ann.id)).toBeUndefined();
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.bea.id));
    await w.mirror([w.bea.id, '00000000-0000-7000-8000-000000000000']);
    expect((await w.rows()).map((row) => row.moderatorId)).toEqual([w.cy.id]);
  });

  test('only the instance itself, and only for a remote community that is still there', async () => {
    const w = await world();
    const denied = async (principal: Parameters<typeof authorize>[1], communityId = w.lab.id) => {
      const decision = await authorize('remote.moderators_mirror', principal, { communityId });
      return decision.ok ? 'allowed' : decision.reason;
    };
    expect(await denied({ kind: 'anonymous' })).toBe('auth.required');
    expect(await denied({ kind: 'local', actorId: w.ann.id, siteRole: 'admin' })).toBe('auth.required');
    expect(await denied(await systemPrincipal(db(), 'scheduled'))).toBe('auth.required');
    expect(await denied(await w.importer())).toBe('allowed');
    const { localCommunity } = await localGroup(w);
    expect(await denied(await w.importer(), localCommunity.id)).toBe('target.not_found');
    expect(await denied(await w.importer(), '00000000-0000-7000-8000-000000000000')).toBe('target.not_found');
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.lab.id));
    expect(await denied(await w.importer())).not.toBe('allowed');
  });
});

async function localGroup(w: Awaited<ReturnType<typeof world>>) {
  return { localCommunity: await seedActor(w.instance, 'Group', 'home') };
}

describe('communities due for a refresh', () => {
  test('followed remote Groups with a moderators collection and no mirror, or one running out; not the others', async () => {
    const w = await world();
    const follower = await seedActor(w.instance, 'Person', 'alice');
    const follow = (community: { id: string }, n: number) =>
      writer()
        .insert(follows)
        .values({
          followerId: follower.id,
          followeeId: community.id,
          apId: `https://fed-a.test/follow/${n}`,
          state: 'accepted',
          acceptedAt: new Date(),
        });
    const spare = await seedActor(w.lemmy, 'Group', 'spare', { moderatorsUrl: 'https://lemmy.test/c/spare/moderators' });
    // `quiet` has a collection and no local follower.
    await seedActor(w.lemmy, 'Group', 'quiet', { moderatorsUrl: 'https://lemmy.test/c/quiet/moderators' });
    const noCollection = await seedActor(w.lemmy, 'Group', 'bare', { moderatorsUrl: null });
    await follow(w.lab, 1);
    await follow(spare, 2);
    await follow(noCollection, 3);
    expect(new Set((await communitiesDueForMirror(db())).map((row) => row.id))).toEqual(new Set([w.lab.id, spare.id]));

    await w.mirror([w.ann.id]);
    await w.mirror([w.ann.id], spare.id);
    expect((await communitiesDueForMirror(db())).map((row) => row.id)).toEqual([]);

    // Within two hours of running out, only that mirror is due.
    await writer()
      .update(communityModerators)
      .set({ expiresAt: new Date(Date.now() + refreshWithinMs - 60_000) })
      .where(eq(communityModerators.communityId, spare.id));
    expect((await communitiesDueForMirror(db())).map((row) => row.id)).toEqual([spare.id]);
  });
});
