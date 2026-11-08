import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { posts } from '../db/tables/content.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { defineMutation } from './mutation.ts';
import { Refused } from './refused.ts';
import { tx } from './tx.ts';

// Two connections, gated so each interleaving happens deterministically: transaction A is a
// rechecking write, transaction B revokes what A's grant relies on.

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** True while some backend in this database waits on a row lock. */
const someoneWaitsOnALock = async () => {
  const [row] = await db().execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return (row?.waiting ?? 0) > 0;
};

const deleteCommunity = (communityId: string) =>
  tx(async (t) => {
    await t.db.update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, communityId));
  });

beforeEach(truncateAll);

async function seed() {
  const instance = await seedInstance('feddit.test');
  const author = await seedActor(instance, 'Person', 'Andrew');
  const community = await seedActor(instance, 'Group', 'announcements');
  const decision = await authorize('post.create', localUser(author.id), { communityId: community.id });
  if (!decision.ok) throw new Error(decision.reason);
  return { community, grant: decision.grant };
}

describe('recheck against a concurrent revocation', () => {
  test('A rechecks first: B waits on the FOR SHARE lock until A commits', async () => {
    const { community, grant } = await seed();
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
        await t.db.insert(posts).values({
          id,
          apId: `${instance.origin}/ap/post/${id}`,
          local: true,
          instanceId: instance.id,
          authorId: g.actorId,
          communityId: g.subject.communityId,
          title: 'Locked in',
          publishedAt: new Date(),
        });
        await t.emit({ type: 'post.created', v: 1, postId: id, communityId: g.subject.communityId, authorId: g.actorId, local: true });
      },
    });
    const order: string[] = [];
    const a = slowCreate(grant, null).then(() => order.push('A committed'));
    await rechecked.opened;
    const b = deleteCommunity(community.id).then(() => order.push('B committed'));
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      expect(order).toEqual([]);
    } finally {
      release.open();
      await Promise.all([a, b]);
    }
    expect(order).toEqual(['A committed', 'B committed']);
    expect(await db().select({ id: posts.id }).from(posts)).toHaveLength(1);
  });

  test("B commits first: A's recheck denies with the exact reason and writes nothing", async () => {
    const { community, grant } = await seed();
    await deleteCommunity(community.id);
    await expect(createPost(grant, { title: 'Too late' })).rejects.toMatchObject({ name: 'Refused', reason: 'target.deleted' });
    expect(await db().select({ id: posts.id }).from(posts)).toHaveLength(0);
  });
});

describe('recheck refreshes the principal', () => {
  const siteBan = defineMutation({
    action: 'mod.site_ban',
    emits: ['mod.ban'],
    recheck: true,
    run: async () => 'banned',
  });

  async function admin() {
    const instance = await seedInstance('feddit.test');
    const [user] = await tx(async (t) =>
      t.db.insert(authUser).values({ name: 'Andrew', email: 'andrew@feddit.test', role: 'admin' }).returning(),
    );
    const andrew = await seedActor(instance, 'Person', 'Andrew', { userId: user!.id });
    const target = await seedActor(instance, 'Person', 'spammer');
    const decision = await authorize(
      'mod.site_ban',
      { kind: 'local', actorId: andrew.id, siteRole: 'admin' },
      { targetActorId: target.id },
    );
    if (!decision.ok) throw new Error(decision.reason);
    return { user: user!, andrew, grant: decision.grant };
  }

  test('an admin demoted between authorize() and the write is refused', async () => {
    const { user, grant } = await admin();
    await tx(async (t) => {
      await t.db.update(authUser).set({ role: 'user' }).where(eq(authUser.id, user.id));
    });
    const attempt = siteBan(grant, null);
    await expect(attempt).rejects.toBeInstanceOf(Refused);
    await expect(attempt).rejects.toMatchObject({ reason: 'auth.admin_required' });
  });

  test('an actor deleted between authorize() and the write is refused', async () => {
    const { andrew, grant } = await admin();
    await tx(async (t) => {
      await t.db.update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, andrew.id));
    });
    await expect(siteBan(grant, null)).rejects.toMatchObject({ reason: 'auth.actor_deleted' });
  });

  test('control: the same grant still works for an admin who stays one', async () => {
    const { grant } = await admin();
    expect(await siteBan(grant, null)).toBe('banned');
  });
});
