import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from '@peblish/core/authz/authorize';
import { deleteAccount } from '@peblish/core/identity/delete';
import { truncateAll } from '@peblish/core/testing/db';
import { seedAccount, seedLocalInstance } from '@peblish/core/testing/seed-a';
import {
  noticesNaming,
  personalRowCount,
  seedPersonalNotices,
  seedPersonalRows,
  seedPersonalTargets,
  type PersonalTableName,
} from '@peblish/core/testing/seed-b06';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { exportLedger, readLedgerExport, reapplyLedger } from './drill.ts';

// The restore replay of a local account deletion clears the personal tables again: a backup
// taken before the deletion brings the account's saves, pins, thread follows and visit markers
// back, with the followed-thread and follow notices that are its or name it, and re-applying the
// ledger removes them, leaving everyone else's. Run on the lane's test database itself (no dump
// needed): the rows a backup would bring back are written again after the deletion, then the
// exported ledger is re-applied.

const url = process.env.DATABASE_URL ?? '';
const dir = mkdtempSync(join(tmpdir(), 'cutover-personal-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

/** Mira's account deleted, then what a backup from before the deletion holds written back by `restore`; answers the replay's report. */
async function replayAfterRestore(restore: (people: { mira: string; lena: string; kai: string }) => Promise<void>, file: string) {
  const mira = await seedAccount('mira');
  const lena = await seedAccount('lena');
  const kai = await seedAccount('kai');
  const people = { mira: mira.actorId, lena: lena.actorId, kai: kai.actorId };
  const decision = await authorize('account.delete', { kind: 'local', actorId: mira.actorId, siteRole: 'user' }, { actorId: mira.actorId });
  if (!decision.ok) throw new Error(decision.reason);
  await deleteAccount(decision.grant, { reason: 'owner request' });
  await restore(people);
  const path = join(dir, `${file}.json`);
  expect(await exportLedger(url, path)).toBe(1);
  expect(await reapplyLedger(url, readLedgerExport(path))).toMatchObject({ applied: 1, absent: 0 });
  return people;
}

// Each table by name, not from personalTables: a table that leaves that list still fails here.
test.each<PersonalTableName>(['saved_posts', 'community_pins', 'thread_watches', 'thread_visits'])(
  'the replay of an account deletion clears its %s rows again',
  async (name) => {
    const people = await replayAfterRestore(async ({ mira, lena }) => {
      const targets = await seedPersonalTargets(lena);
      const rows = { postId: targets.post.id, communityId: targets.community.id };
      await seedPersonalRows(lena, rows);
      await seedPersonalRows(mira, rows);
      expect(await personalRowCount(name, mira)).toBe(1);
    }, name);
    expect(await personalRowCount(name, people.mira)).toBe(0);
    expect(await personalRowCount(name, people.lena)).toBe(1);
  },
);

test("the replay clears the followed-thread and follow notices that are the account's or name it, and no one else's", async () => {
  const people = await replayAfterRestore(async ({ mira, lena, kai }) => {
    await seedPersonalNotices(mira, kai, ['thread_reply']);
    await seedPersonalNotices(mira, null, ['follow_accept']);
    await seedPersonalNotices(lena, mira, ['thread_reply']);
    await seedPersonalNotices(lena, kai, ['thread_reply']);
    await seedPersonalNotices(lena, null, ['follow_accept']);
  }, 'notices');
  expect(await noticesNaming(people.mira)).toEqual([]);
  expect(await noticesNaming(people.lena)).toEqual([
    { kind: 'thread_reply', actorId: people.kai },
    { kind: 'follow_accept', actorId: null },
  ]);
});
