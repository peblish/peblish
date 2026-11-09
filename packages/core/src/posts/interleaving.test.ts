import type { ActingPrincipal } from '@peblish/schema/authz';
import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { currentPrincipal } from '../authz/principal.ts';
import { db, type Queryable } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { truncateAll } from '../testing/db.ts';
import { gate, grantFor, someoneWaitsOnALock } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { seedActor } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { storeRemotePost, type RemotePost } from './remote.ts';

// Two connections, gated so the interleaving that matters happens every run. A remote
// community's row is the community row the policies lock FOR NO KEY UPDATE.

beforeEach(truncateAll);

const announce = (communityId: string) => ({ communityId, announceApId: 'https://lemmy.test/activities/announce/1' });

const record = (n: number): RemotePost => ({
  apId: `https://lemmy.test/post/${n}`,
  title: `Post ${n}`,
  url: null,
  urlContentType: null,
  altText: null,
  thumbnailUrl: null,
  bodyMd: null,
  contentHtml: null,
  sensitive: false,
  nsfl: false,
  language: null,
  publishedAt: null,
  editedAt: null,
  raw: {},
});

describe('a remote community as the acting principal', () => {
  // Without the refusal, each request's refresh holds the community's own row FOR SHARE and its
  // policy then waits to take it FOR NO KEY UPDATE behind the other's share: 40P01.
  test.each(['post.create', 'vote.cast'] as const)('two concurrent %s requests are both refused; neither deadlocks', async (action) => {
    const world = await seedPostWorld();
    const group: ActingPrincipal = { kind: 'remote', actorId: world.communities.remote.id, announcedBy: null };
    const request = async (db: Queryable) => {
      const decision =
        action === 'post.create'
          ? await authorize('post.create', group, { communityId: world.communities.remote.id }, { db, lock: true })
          : await authorize('vote.cast', group, { target: { kind: 'post', id: world.posts.remote.normal } }, { db, lock: true });
      return decision.ok ? 'allowed' : decision.reason;
    };
    const refreshed = gate();
    const release = gate();
    // The first request stops where the cycle needs it: its principal refreshed, its policy not yet run.
    const first = tx(async (t) => {
      expect(await currentPrincipal(t.db, group)).toMatchObject({ ok: true });
      refreshed.open();
      await release.opened;
      return request(t.db);
    });
    await refreshed.opened;
    let finished = false;
    const second = tx((t) => request(t.db)).finally(() => (finished = true));
    // The refusal comes before any lock: the second request is answered while the first still holds
    // the community row. A policy that locks first would wait here and the poll would time out.
    await expect.poll(() => finished).toBe(true);
    release.open();
    await expect(Promise.all([first, second])).resolves.toEqual(['post.group_cannot_act', 'post.group_cannot_act']);
  });
});

describe('remote Persons creating through the owning community’s Announce', () => {
  test('two concurrent creates take turns on the community row; neither deadlocks', async () => {
    const world = await seedPostWorld();
    const community = world.communities.remote;
    const another = await seedActor(world.instances.lemmy, 'Person', 'another_author');
    const announcedBy = announce(community.id);
    const principals = [world.people.remoteAuthor, another].map((person): ActingPrincipal => ({
      kind: 'remote',
      actorId: person.id,
      announcedBy,
    }));
    const [firstGrant, secondGrant] = await Promise.all(principals.map((p) => grantFor('post.create', p, { communityId: community.id })));
    if (!firstGrant || !secondGrant) throw new Error('grants');
    const holding = gate();
    const release = gate();
    // The first create holds the community row (its recheck) until it is released.
    const first = tx(async (t) => {
      const stored = await storeRemotePost.within(t, firstGrant, record(1));
      holding.open();
      await release.opened;
      return stored;
    });
    await holding.opened;
    const second = storeRemotePost(secondGrant, record(2));
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
    } finally {
      release.open();
    }
    const stored = await Promise.all([first, second]);
    expect(stored.map(({ created }) => created)).toEqual([true, true]);
    const rows = await db()
      .select({ apId: posts.apId })
      .from(posts)
      .where(inArray(posts.apId, [record(1).apId, record(2).apId]));
    expect(rows).toHaveLength(2);
  });
});
