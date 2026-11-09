import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { seedComment, seedPost } from '../testing/seed-az.ts';
import { tx } from '../tx/tx.ts';
import { recordDeletion, recordRestoration } from './ledger.ts';

beforeEach(truncateAll);

async function world() {
  const lemmy = await seedInstance('lemmy.test', false);
  const community = await seedActor(lemmy, 'Group', 'lab', { apId: 'https://lemmy.test/c/lab' });
  const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob' });
  const post = await seedPost(lemmy, community, bob, { apId: 'https://lemmy.test/post/1' });
  const comment = await seedComment(lemmy, post, bob, { apId: 'https://lemmy.test/comment/1' });
  return { bob, post, comment };
}
const ledger = async () => (await db().select().from(deletionLedger)).sort((a, b) => a.id - b.id);

describe('recordDeletion', () => {
  test('writes one ledger row for a post, a comment or an actor, with the subject’s ap_id and who asked', async () => {
    const w = await world();
    await tx(async (t) => {
      await recordDeletion(t, { kind: 'post', id: w.post.id, cause: 'Delete', actorId: w.bob.id });
      await recordDeletion(t, { kind: 'comment', id: w.comment.id, cause: 'Gone', actorId: w.bob.id });
      await recordDeletion(t, { kind: 'actor', id: w.bob.id, cause: 'Tombstone', actorId: w.bob.id, removeContent: true });
    });
    expect(await ledger()).toMatchObject([
      {
        subjectKind: 'post',
        subjectId: w.post.id,
        subjectApId: w.post.apId,
        reason: 'remote.object_deleted',
        requestedBy: w.bob.id,
        details: { remote: true, cause: 'Delete' },
      },
      { subjectKind: 'comment', subjectApId: w.comment.apId, reason: 'remote.object_gone', details: { remote: true, cause: 'Gone' } },
      {
        subjectKind: 'actor',
        subjectApId: w.bob.apId,
        reason: 'remote.actor_deleted',
        details: { cause: 'Tombstone', removeContent: true },
      },
    ]);
    expect((await ledger())[0]?.details).not.toHaveProperty('removeContent');
  });

  test('recordRestoration writes the row that takes an author’s Delete back', async () => {
    const w = await world();
    await tx(async (t) => {
      await recordDeletion(t, { kind: 'comment', id: w.comment.id, cause: 'Delete', actorId: w.bob.id });
      await recordRestoration(t, { kind: 'comment', id: w.comment.id, actorId: w.bob.id });
    });
    expect((await ledger()).map((row) => [row.reason, row.subjectApId])).toEqual([
      ['remote.object_deleted', w.comment.apId],
      ['remote.object_undeleted', w.comment.apId],
    ]);
  });

  test('commits with the caller’s transaction and not without it', async () => {
    const w = await world();
    await expect(
      tx(async (t) => {
        await recordDeletion(t, { kind: 'post', id: w.post.id, cause: 'Delete', actorId: w.bob.id });
        throw new Error('the delete did not apply');
      }),
    ).rejects.toThrow('did not apply');
    expect(await ledger()).toEqual([]);
  });
});
