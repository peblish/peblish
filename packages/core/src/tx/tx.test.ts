import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { inboxDedupe } from '../db/tables/federation.ts';
import { outbox } from '../db/tables/outbox.ts';
import { truncateAll } from '../testing/db.ts';
import { postWithFault } from '../testing/fault-mutation.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import type { Authorized } from '../authz/brand.ts';
import { tx } from './tx.ts';

// Fault injection for the unit of work the inbound pipeline runs: dedupe marker, apply,
// enqueue. A crash between apply and enqueue must leave no state, no outbox row and no marker.

const activityId = 'https://lemmy.test/activities/create/1';
const postId = '0192f5a0-0000-7000-8000-00000000f001';

async function seed() {
  const instance = await seedInstance('feddit.test');
  const author = await seedActor(instance, 'Person', 'Andrew');
  const community = await seedActor(instance, 'Group', 'announcements');
  const decision = await authorize('post.create', localUser(author.id), { communityId: community.id });
  if (!decision.ok) throw new Error(decision.reason);
  return { author, community, grant: decision.grant };
}

function applyOnce(mutation: ReturnType<typeof postWithFault>, grant: Authorized<'post.create'>, id: string) {
  return tx(async (t) => {
    if (!(await t.dedupe(activityId))) return 'duplicate';
    await mutation.within(t, grant, { id });
    return 'applied';
  });
}

async function persisted() {
  const [counts] = await db().execute<{ posts: number; outbox: number; markers: number }>(sql`
    select (select count(*) from ${posts})::int as posts,
           (select count(*) from ${outbox})::int as outbox,
           (select count(*) from ${inboxDedupe})::int as markers`);
  return counts;
}

beforeEach(truncateAll);

describe('tx plus emit', () => {
  test('control: state, outbox row and dedupe marker commit together, and a replay is skipped', async () => {
    const { grant } = await seed();
    const mutation = postWithFault(async () => {});
    expect(await applyOnce(mutation, grant, postId)).toBe('applied');
    expect(await persisted()).toEqual({ posts: 1, outbox: 1, markers: 1 });
    expect(await applyOnce(mutation, grant, '0192f5a0-0000-7000-8000-00000000f002')).toBe('duplicate');
    expect(await persisted()).toEqual({ posts: 1, outbox: 1, markers: 1 });
    const [row] = await db().select().from(outbox);
    expect(row).toMatchObject({ type: 'post.created', v: 1, payload: { type: 'post.created', v: 1, postId } });
  });

  test('an exception between apply and enqueue leaves nothing behind', async () => {
    const { grant } = await seed();
    const mutation = postWithFault(async () => {
      throw new Error('injected crash');
    });
    await expect(applyOnce(mutation, grant, postId)).rejects.toThrow('injected crash');
    expect(await persisted()).toEqual({ posts: 0, outbox: 0, markers: 0 });
  });

  test('a process killed between apply and enqueue leaves nothing behind', async () => {
    const { author, community } = await seed();
    const child = join(import.meta.dirname, '../testing/crash-child.ts');
    const exit = await new Promise<{ signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [child, author.id, community.id, postId, activityId], { env: process.env }, (error, stdout, stderr) =>
        resolve({ signal: error?.signal ?? null, stdout, stderr }),
      );
    });
    expect(exit).toEqual({ signal: 'SIGKILL', stdout: 'applied\n', stderr: '' });
    expect(await persisted()).toEqual({ posts: 0, outbox: 0, markers: 0 });
  });

  test('emit validates the event against the union', async () => {
    await expect(
      tx(async (t) => {
        // @ts-expect-error: a required field of post.created is missing
        await t.emit({ type: 'post.created', v: 1 });
      }),
    ).rejects.toThrow();
    expect(await persisted()).toEqual({ posts: 0, outbox: 0, markers: 0 });
  });
});
