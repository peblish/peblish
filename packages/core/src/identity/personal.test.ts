import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance } from '../testing/seed-a.ts';
import {
  noticesNaming,
  personalRowCount,
  seedPersonalNotices,
  seedPersonalRows,
  seedPersonalTargets,
  type PersonalTableName,
} from '../testing/seed-b06.ts';
import { deleteAccount } from './delete.ts';

// Account deletion keeps the actor row, so no foreign key cascade reaches the personal tables:
// deleteAccount clears each of them for the deleted account, and only for it, with the notices of
// the personal kinds that are the account's or name it.

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

async function world() {
  const mira = await seedAccount('mira');
  const lena = await seedAccount('lena');
  const kai = await seedAccount('kai');
  const targets = await seedPersonalTargets(lena.actorId);
  const rows = { postId: targets.post.id, communityId: targets.community.id };
  await seedPersonalRows(mira.actorId, rows);
  await seedPersonalRows(lena.actorId, rows);
  const deleteMira = async () => {
    const decision = await authorize(
      'account.delete',
      { kind: 'local', actorId: mira.actorId, siteRole: 'user' },
      { actorId: mira.actorId },
    );
    if (!decision.ok) throw new Error(decision.reason);
    await deleteAccount(decision.grant, { reason: 'owner request' });
  };
  return { mira, lena, kai, deleteMira };
}

// Each table by name, not from personalTables: a table that leaves that list still fails here.
test.each<PersonalTableName>(['saved_posts', 'community_pins', 'thread_watches', 'thread_visits'])(
  "deleting an account clears its %s rows and no one else's",
  async (name) => {
    const { mira, lena, deleteMira } = await world();
    await deleteMira();
    expect(await personalRowCount(name, mira.actorId)).toBe(0);
    expect(await personalRowCount(name, lena.actorId)).toBe(1);
  },
);

test("deleting an account clears the followed-thread and follow notices that are its or name it, and no one else's", async () => {
  const { mira, lena, kai, deleteMira } = await world();
  await seedPersonalNotices(mira.actorId, kai.actorId, ['thread_reply']);
  await seedPersonalNotices(mira.actorId, null, ['follow_accept']);
  await seedPersonalNotices(lena.actorId, mira.actorId, ['thread_reply']);
  await seedPersonalNotices(lena.actorId, kai.actorId, ['thread_reply']);
  await seedPersonalNotices(lena.actorId, null, ['follow_accept']);
  await deleteMira();
  expect(await noticesNaming(mira.actorId)).toEqual([]);
  expect(await noticesNaming(lena.actorId)).toEqual([
    { kind: 'thread_reply', actorId: kai.actorId },
    { kind: 'follow_accept', actorId: null },
  ]);
});
