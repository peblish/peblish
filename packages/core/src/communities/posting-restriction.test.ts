import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor } from '../testing/seed-az.ts';
import { person, seedCommunityWorld } from '../testing/seed-f.ts';
import { createCommunityAs } from './create.ts';
import { setModeratorAs } from './moderators.ts';
import { updateCommunityAs } from './update.ts';

// Lane B1 enforces the flag in post.create (community.posting_restricted); lane F sets it and
// proves it here, end to end.

beforeEach(truncateAll);

async function setup() {
  const { instances, people } = await seedCommunityWorld();
  const admin = person(people.admin.id, 'admin');
  const made = await createCommunityAs(admin, { name: 'notices' });
  if (!made.ok) throw new Error(made.reason);
  const appointed = await setModeratorAs(admin, { communityId: made.id, actorId: people.moderator.id, role: 'moderator' });
  if (!appointed.ok) throw new Error(appointed.reason);
  const other = await createCommunityAs(admin, { name: 'open_board' });
  if (!other.ok) throw new Error(other.reason);
  return {
    instances,
    people,
    admin,
    communityId: made.id,
    otherId: other.id,
    moderator: person(people.moderator.id),
    member: person(people.member.id),
  };
}

describe('postingRestrictedToMods end to end', () => {
  test('once a moderator sets the flag, a member is refused with community.posting_restricted while a moderator and the owner still post', async () => {
    const { people, admin, communityId, otherId, moderator, member } = await setup();
    const subject = { communityId };
    expect(await authorize('post.create', member, subject)).toMatchObject({ ok: true });

    expect(await updateCommunityAs(moderator, communityId, { postingRestrictedToMods: true })).toEqual({ ok: true });
    expect(await authorize('post.create', member, subject)).toEqual({ ok: false, reason: 'community.posting_restricted' });
    expect(await authorize('post.create', member, { communityId: otherId })).toMatchObject({ ok: true });
    for (const who of [moderator, admin]) expect(await authorize('post.create', who, subject)).toMatchObject({ ok: true });

    const created = await createPost(await grantFor('post.create', moderator, subject), { title: 'Read this first' });
    const [post] = await db()
      .select({ authorId: posts.authorId, communityId: posts.communityId })
      .from(posts)
      .where(eq(posts.id, created.id));
    expect(post).toEqual({ authorId: people.moderator.id, communityId });

    expect(await updateCommunityAs(admin, communityId, { postingRestrictedToMods: false })).toEqual({ ok: true });
    expect(await authorize('post.create', member, subject)).toMatchObject({ ok: true });
  });

  test('a member whose grant predates the flag is refused by post.create’s recheck, and nothing is written', async () => {
    const { communityId, moderator, member } = await setup();
    const grant = await grantFor('post.create', member, { communityId });
    await updateCommunityAs(moderator, communityId, { postingRestrictedToMods: true });
    // Refused's reason is typed to the closed union, which gains this value only when B1 merges.
    await expect(createPost(grant, { title: 'Too late' })).rejects.toMatchObject({
      name: 'Refused',
      action: 'post.create',
      reason: 'community.posting_restricted',
    });
    expect(await db().select({ id: posts.id }).from(posts)).toEqual([]);
  });
});
