import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments } from '@peblish/core/db/tables/content';
import { truncateAll } from '@peblish/core/testing/db';
import { seedInstance } from '@peblish/core/testing/seed';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';

// Mbin 1.11 addresses a comment's Delete to the post's author before the community. The documents below were captured from the lab's inbox_raw (2026-11-10), with the
// lab's hosts mapped onto the test world: mbin.lab.test is mbin.test (its magazine `/m/lab` is
// seeded at `/c/lab`), peblish.lab.test's !lab is this world's !spike and alice is alice.

const mbin = 'https://mbin.test';
const magazine = `${mbin}/c/lab`;
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const context = ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1', `${mbin}/contexts`];

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
let peers: Record<'mbinadmin' | 'mbinuser' | 'magazine', Awaited<ReturnType<typeof seedPeerActor>>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
  const instance = await seedInstance('mbin.test', false);
  peers = {
    mbinadmin: await seedPeerActor(instance, 'Person', 'mbinadmin'),
    mbinuser: await seedPeerActor(instance, 'Person', 'mbinuser'),
    magazine: await seedPeerActor(instance, 'Group', 'lab'),
  };
});

const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));

/** Mbin's Delete of its own thread or comment: a Tombstone, addressed as captured. */
const remove = (actor: string, objectApId: string, n: number, to: string[], cc: string[]) => ({
  '@context': context,
  id: `${mbin}/f/object/delete-${n}`,
  type: 'Delete',
  actor,
  object: { id: objectApId, type: 'Tombstone' },
  to,
  cc,
});

describe("Mbin's Delete of its comment on a post here", () => {
  test('names the community after the post’s author, and the community is found among every addressee', async () => {
    const spike = world.community.apId;
    const alice = world.alice.apId;
    const comment = await seedComment(world.instances.local, world.t1, peers.mbinuser, {
      apId: `${mbin}/m/lab@fed-b.test/t/14/-/comment/5`,
      local: false,
    });
    // As captured for C1: Public and the post's author in `to`, the community and the followers in `cc`, no audience.
    const json = remove(peers.mbinuser.apId, comment.apId, 50, [PUBLIC, alice], [spike, `${peers.mbinuser.apId}/followers`]);
    expect((await deliver(json)).stored).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.deletedAt).not.toBeNull();
  });

  test('naming another community anywhere and this one nowhere is still a mismatch', async () => {
    const comment = await seedComment(world.instances.local, world.t1, peers.mbinuser, {
      apId: `${mbin}/m/lab@fed-b.test/t/14/-/comment/6`,
      local: false,
    });
    const json = remove(peers.mbinuser.apId, comment.apId, 60, [PUBLIC], [magazine]);
    expect((await deliver(json)).stored).toEqual({
      state: 'skipped',
      error: `community.mismatch ${magazine} is not ${world.community.apId}`,
    });
  });
});
