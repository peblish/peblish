import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { deleteRemoteActor } from '@peblish/core/remote/actors';
import { truncateAll } from '@peblish/core/testing/db';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { importGrant } from '../actors/grants.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

// Delete and Undo(Delete): who may delete what, what the ledger records, and what a Delete of
// something that is not content is told.

const lemmy = 'https://lemmy.test';
const { spike, lab, lemmyuser, t1 } = hosts;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));
const del = (actor: string, object: string, extra: Record<string, unknown> = {}) => ({
  id: activityId(lemmy, 'delete'),
  type: 'Delete',
  actor,
  object,
  ...addressedToCommunity(spike),
  ...extra,
});
const ledger = async () =>
  (await db().select().from(deletionLedger).orderBy(asc(deletionLedger.id))).map((row) => ({ ...row, createdAt: undefined }));

describe('an author’s own Delete', () => {
  test('of a post or a comment is recorded in the deletion ledger with the actor who sent it, and its Undo after it', async () => {
    const comment = await seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/9`, local: false });
    expect((await deliver(del(lemmyuser, comment.apId))).stored?.state).toBe('applied');
    const postDelete = del(lemmyuser, t1);
    expect((await deliver(postDelete)).stored?.state).toBe('applied');
    expect((await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.deletedAt).not.toBeNull();
    expect(await ledger()).toMatchObject([
      {
        subjectKind: 'comment',
        subjectId: comment.id,
        subjectApId: comment.apId,
        requestedBy: world.peers.lemmyuser.id,
        details: { remote: true, cause: 'Delete' },
      },
      {
        subjectKind: 'post',
        subjectId: world.t1.id,
        subjectApId: t1,
        requestedBy: world.peers.lemmyuser.id,
        details: { remote: true, cause: 'Delete' },
      },
    ]);

    // Taking the post's Delete back is recorded after it, so a restore that replays the ledger ends with the post alive.
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: postDelete, ...addressedToCommunity(spike) };
    expect((await deliver(undo)).stored?.state).toBe('applied');
    expect((await db().select().from(posts).where(eq(posts.apId, t1)))[0]?.deletedAt).toBeNull();
    expect((await ledger()).map((row) => [row.subjectKind, row.reason])).toEqual([
      ['comment', 'remote.object_deleted'],
      ['post', 'remote.object_deleted'],
      ['post', 'remote.object_undeleted'],
    ]);
  });

  test('is not recorded when a moderator removed the post instead (that is mod.remove’s record)', async () => {
    expect((await deliver(del(hosts.lemmyadmin, t1, { summary: 'spam' }))).stored?.state).toBe('applied');
    expect(await ledger()).toEqual([]);
  });

  test('of a comment is taken back by its author’s Undo, which the ledger records after it', async () => {
    const comment = await seedComment(world.instances.lemmy, world.t1, world.peers.lemmyuser, { apId: `${lemmy}/comment/9`, local: false });
    const commentDelete = del(lemmyuser, comment.apId);
    expect((await deliver(commentDelete)).stored?.state).toBe('applied');
    const undo = { id: activityId(lemmy, 'undo'), type: 'Undo', actor: lemmyuser, object: commentDelete, ...addressedToCommunity(spike) };
    expect((await deliver(undo)).stored).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.deletedAt).toBeNull();
    expect((await ledger()).map((row) => [row.subjectKind, row.reason])).toEqual([
      ['comment', 'remote.object_deleted'],
      ['comment', 'remote.object_undeleted'],
    ]);
  });

  test('of an account a Tombstone deleted still removes its content with removeData, and is applied', async () => {
    await deleteRemoteActor(await importGrant('remote.actor_delete', { apId: lemmyuser }), { cause: 'Tombstone' });
    const deletedAt = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0]?.deletedAt;
    expect(await deletedAt(t1)).toBeNull();
    const own = { id: activityId(lemmy, 'delete'), type: 'Delete', actor: lemmyuser, object: lemmyuser, to: [PUBLIC], removeData: true };
    expect((await deliver(own)).stored).toEqual({ state: 'applied', error: null });
    expect(await deletedAt(t1)).not.toBeNull();
    expect(await deletedAt(world.t2.apId)).not.toBeNull();
  });
});

describe('a Delete of something that is not content here', () => {
  test('names a whole community, another account, or an object that has not arrived', async () => {
    expect((await deliver(del(hosts.lemmyadmin, lab))).stored?.error).toBe(`community.delete_unsupported ${lab}`);
    expect((await deliver(del(hosts.lemmyadmin, spike))).stored?.error).toBe(`community.delete_unsupported ${spike}`);
    expect((await deliver(del(hosts.lemmyadmin, hosts.pfuser))).stored?.error).toBe(`delete.target_unsupported ${hosts.pfuser}`);
    expect((await deliver(del(hosts.lemmyadmin, `${lemmy}/post/none`))).stored?.error).toBe(`target.missing ${lemmy}/post/none`);
  });

  test('is the community’s own when it deletes itself', async () => {
    const own = {
      id: activityId(lemmy, 'delete'),
      type: 'Delete',
      actor: lab,
      object: lab,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    expect((await deliver(own)).stored?.state).toBe('applied');
  });
});
