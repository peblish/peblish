import type { ActingPrincipal } from '@peblish/schema/authz';
import { beforeAll, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { currentPrincipal } from '../authz/principal.ts';
import type { Queryable } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { gate, someoneWaitsOnALock } from '../testing/seed-az.ts';
import { seedCommentWorld } from '../testing/seed-d.ts';
import { tx } from '../tx/tx.ts';

// A remote community's row is the community row the policies lock FOR NO KEY UPDATE, and its
// own principal's refresh holds the same row FOR SHARE. Without the refusal before any locked
// read, each of two concurrent requests holds the share and waits to take the row for update
// behind the other's share: 40P01. Gated, so the interleaving happens every run.

let world: Awaited<ReturnType<typeof seedCommentWorld>>;
beforeAll(async () => {
  await truncateAll();
  world = await seedCommentWorld();
});

test.each(['comment.update', 'comment.delete', 'comment.restore'] as const)(
  'two concurrent %s requests from a remote community are both refused; neither deadlocks',
  async (action) => {
    const group: ActingPrincipal = { kind: 'remote', actorId: world.communities.remote.id, announcedBy: null };
    const request = async (db: Queryable) => {
      const decision = await authorize(action, group, { commentId: world.comments.remote }, { db, lock: true });
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
    // The second request either waits on a lock (a policy that locks first) or is already done.
    await expect.poll(async () => finished || (await someoneWaitsOnALock())).toBe(true);
    release.open();
    await expect(Promise.all([first, second])).resolves.toEqual(['comment.group_cannot_act', 'comment.group_cannot_act']);
  },
);
