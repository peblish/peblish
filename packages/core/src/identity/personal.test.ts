import { getTableName } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance } from '../testing/seed-a.ts';
import { personalRowCounts, seedPersonalRows, seedPersonalTargets } from '../testing/seed-b06.ts';
import { deleteAccount } from './delete.ts';
import { personalTables } from './personal.ts';

// Account deletion keeps the actor row, so no foreign key cascade reaches the personal tables:
// deleteAccount clears each of them for the deleted account, and only for it.

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

test.each(personalTables.map((table) => getTableName(table)))("deleting an account clears its %s rows and no one else's", async (name) => {
  const mira = await seedAccount('mira');
  const lena = await seedAccount('lena');
  const targets = await seedPersonalTargets(lena.actorId);
  const rows = { postId: targets.post.id, communityId: targets.community.id };
  await seedPersonalRows(mira.actorId, rows);
  await seedPersonalRows(lena.actorId, rows);

  const decision = await authorize('account.delete', { kind: 'local', actorId: mira.actorId, siteRole: 'user' }, { actorId: mira.actorId });
  if (!decision.ok) throw new Error(decision.reason);
  await deleteAccount(decision.grant, { reason: 'owner request' });

  expect((await personalRowCounts(mira.actorId))[name]).toBe(0);
  expect((await personalRowCounts(lena.actorId))[name]).toBe(1);
});
