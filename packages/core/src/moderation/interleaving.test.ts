import type { ActingPrincipal } from '@peblish/schema/authz';
import { isNotNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { currentPrincipal } from '../authz/principal.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { posts } from '../db/tables/content.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import { gate, grantFor, seedModerator, seedPost, someoneWaitsOnALock } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { defineMutation } from '../tx/mutation.ts';
import { tx } from '../tx/tx.ts';
import { banFromCommunity } from './ban.ts';
import { removeContent } from './remove.ts';
import { communityBans } from './tables.ts';

// A community ban is an INSERT, so no lock on the (missing) ban row can order it against a
// rechecking write. Both lock the community's actor row FOR NO KEY UPDATE instead: a ban that
// commits between the recheck's read and the write's commit is either seen or waits.

beforeEach(truncateAll);

async function setup() {
  const instance = await seedInstance('feddit.test');
  const author = await seedActor(instance, 'Person', 'author');
  const moderator = await seedActor(instance, 'Person', 'moderator');
  const community = await seedActor(instance, 'Group', 'announcements');
  await seedModerator(community, moderator);
  const postGrant = await grantFor('post.create', localUser(author.id), { communityId: community.id });
  const banGrant = await grantFor('mod.ban', localUser(moderator.id), { communityId: community.id, targetActorId: author.id });
  return { postGrant, banGrant };
}

describe('post.create against a concurrent community ban', () => {
  test('the post rechecks first: the ban waits on the community row until the post commits', async () => {
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
        const instance = await localInstance(t.db);
        const id = uuidv7();
        const { communityId } = g.subject;
        await t.db.insert(posts).values({
          id,
          apId: `${instance.origin}/ap/post/${id}`,
          local: true,
          instanceId: instance.id,
          authorId: g.actorId,
          communityId,
          title: 'Just in time',
          publishedAt: new Date(),
        });
        await t.emit({ type: 'post.created', v: 1, postId: id, communityId, authorId: g.actorId, local: true });
      },
    });
    const order: string[] = [];
    const post = slowCreate(postGrant, null).then(() => order.push('post committed'));
    await rechecked.opened;
    const ban = banFromCommunity(banGrant, { reason: 'Spam' }).then(() => order.push('ban committed'));
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      expect(order).toEqual([]);
    } finally {
      release.open();
      await Promise.all([post, ban]);
    }
    expect(order).toEqual(['post committed', 'ban committed']);
    expect(await db().select({ id: posts.id }).from(posts)).toHaveLength(1);
    expect(await db().select().from(communityBans)).toHaveLength(1);
  });

  test("the ban commits first: the post's recheck refuses with community.banned and writes nothing", async () => {
    const { postGrant, banGrant } = await setup();
    await banFromCommunity(banGrant, { reason: 'Spam' });
    await expect(createPost(postGrant, { title: 'Too late' })).rejects.toMatchObject({ name: 'Refused', reason: 'community.banned' });
    expect(await db().select({ id: posts.id }).from(posts)).toHaveLength(0);
  });
});

describe('a remote community acting as itself (its own Announce relays its activity)', () => {
  // The principal refresh reads the acting actor's row and the policy then locks the community
  // row FOR NO KEY UPDATE. Here both are one row, so a refresh FOR SHARE would let two requests
  // share it and then each wait for the other to upgrade (40P01).
  test('two concurrent moderation requests take turns on the community row; neither deadlocks', async () => {
    const lemmy = await seedInstance('lemmy.test', false);
    const author = await seedActor(lemmy, 'Person', 'someone');
    const technology = await seedActor(lemmy, 'Group', 'technology');
    const principal: ActingPrincipal = {
      kind: 'remote',
      actorId: technology.id,
      announcedBy: { communityId: technology.id, announceApId: 'https://lemmy.test/activities/announce/1' },
    };
    const removal = async () =>
      grantFor('mod.remove', principal, { target: { kind: 'post', id: (await seedPost(lemmy, technology, author)).id } });
    const firstGrant = await removal();
    const secondGrant = await removal();
    const refreshed = gate();
    const release = gate();
    // The first request stops where the deadlock needs it: its principal refreshed, its policy not yet run.
    const first = tx(async (t) => {
      expect(await currentPrincipal(t.db, principal)).toMatchObject({ ok: true });
      refreshed.open();
      await release.opened;
      return removeContent.within(t, firstGrant, { reason: 'Spam' });
    });
    await refreshed.opened;
    const second = removeContent(secondGrant, { reason: 'Spam' });
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
    } finally {
      release.open();
    }
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(await db().select({ id: posts.id }).from(posts).where(isNotNull(posts.removedAt))).toHaveLength(2);
  });
});
