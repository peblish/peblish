import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { authorize } from './authorize.ts';
import { Authorized } from './brand.ts';
import { SnapshotError } from './frozen.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const remote = await seedInstance('lemmy.test', false);
  return {
    andrew: await seedActor(local, 'Person', 'Andrew'),
    community: await seedActor(local, 'Group', 'announcements'),
    remoteUser: await seedActor(remote, 'Person', 'someone'),
  };
}

describe('authorize', () => {
  test('refuses with exactly one closed reason', async () => {
    const { andrew, community } = await world();
    expect(await authorize('post.create', { kind: 'anonymous' }, { communityId: community.id })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await authorize('post.create', localUser(andrew.id), { communityId: andrew.id })).toEqual({
      ok: false,
      reason: 'target.not_found',
    });
    await tx(async (t) => {
      await t.db.update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, community.id));
    });
    expect(await authorize('post.create', localUser(andrew.id), { communityId: community.id })).toEqual({
      ok: false,
      reason: 'target.deleted',
    });
  });

  test('allows with a grant bound to the action, the subject and the authority', async () => {
    const { andrew, community } = await world();
    const decision = await authorize('post.create', localUser(andrew.id), { communityId: community.id });
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.grant).toBeInstanceOf(Authorized);
    expect(decision.grant).toMatchObject({
      action: 'post.create',
      actorId: andrew.id,
      subject: { communityId: community.id },
      authority: { kind: 'local-role', actorId: andrew.id, role: 'user', communityId: community.id },
    });
    expect(Object.isFrozen(decision.grant)).toBe(true);
    const { id } = await createPost(decision.grant, { title: 'Hello' });
    const [post] = await tx(async (t) => t.db.select().from(posts).where(eq(posts.id, id)));
    expect(post).toMatchObject({ authorId: andrew.id, communityId: community.id, local: true, apId: `https://feddit.test/ap/post/${id}` });
  });

  test('a mutation refuses a forged or mismatched grant at runtime too', async () => {
    const { andrew, community } = await world();
    const forged = Object.create(Authorized.prototype);
    Object.assign(forged, { action: 'post.create', actorId: andrew.id, subject: { communityId: community.id } });
    await expect(createPost(forged, { title: 'Forged' })).rejects.toThrow(/needs a grant from authorize/);
    const voteGrant = await authorize('vote.cast', localUser(andrew.id), { target: { kind: 'post', id: community.id } });
    expect(voteGrant).toEqual({ ok: false, reason: 'target.not_found' });
  });

  test("changing the caller's objects after authorize() changes neither the grant nor the write", async () => {
    const local = await seedInstance('feddit.test');
    const andrew = await seedActor(local, 'Person', 'Andrew');
    const mallory = await seedActor(local, 'Person', 'mallory');
    const community = await seedActor(local, 'Group', 'announcements');
    const otherCommunity = await seedActor(local, 'Group', 'elsewhere');
    const principal: { kind: 'local'; actorId: string; siteRole: 'user' | 'admin' } = {
      kind: 'local',
      actorId: andrew.id,
      siteRole: 'user',
    };
    const subject = { communityId: community.id };
    const decision = await authorize('post.create', principal, subject);
    if (!decision.ok) throw new Error(decision.reason);
    principal.actorId = mallory.id;
    principal.siteRole = 'admin';
    subject.communityId = otherCommunity.id;

    const { grant } = decision;
    expect(grant.principal).toEqual({ kind: 'local', actorId: andrew.id, siteRole: 'user' });
    expect(grant.subject).toEqual({ communityId: community.id });
    for (const part of [grant.principal, grant.subject, grant.authority]) expect(Object.isFrozen(part)).toBe(true);
    expect(() => Object.assign(grant.subject, { communityId: otherCommunity.id })).toThrow(TypeError);

    const { id } = await createPost(grant, { title: 'Still mine' });
    const [post] = await tx(async (t) => t.db.select().from(posts).where(eq(posts.id, id)));
    expect(post).toMatchObject({ authorId: andrew.id, communityId: community.id });
  });

  test('with lock, the snapshot is taken before the principal refresh awaits', async () => {
    const { andrew, community } = await world();
    const local = await seedInstance('second.test', false);
    const otherCommunity = await seedActor(local, 'Group', 'elsewhere');
    const subject = { communityId: community.id };
    const grant = await tx(async (t) => {
      const pending = authorize('post.create', localUser(andrew.id), subject, { db: t.db, lock: true });
      // authorize() has yielded at its first await (the principal refresh); the snapshot must already exist.
      subject.communityId = otherCommunity.id;
      const decision = await pending;
      if (!decision.ok) throw new Error(decision.reason);
      return decision.grant;
    });
    expect(grant.subject).toEqual({ communityId: community.id });
  });

  test('input that is not JSON-like plain data is refused with SnapshotError', async () => {
    const { andrew, community } = await world();
    const subject = { communityId: community.id, at: new Date() };
    await expect(authorize('post.create', localUser(andrew.id), subject)).rejects.toThrow(SnapshotError);
    await expect(authorize('post.create', localUser(andrew.id), subject)).rejects.toMatchObject({ path: 'subject.at', found: 'Date' });
  });
});
