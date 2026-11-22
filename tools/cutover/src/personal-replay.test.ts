import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from '@peblish/core/authz/authorize';
import { personalTables } from '@peblish/core/identity/personal';
import { deleteAccount } from '@peblish/core/identity/delete';
import { truncateAll } from '@peblish/core/testing/db';
import { seedAccount, seedLocalInstance } from '@peblish/core/testing/seed-a';
import { personalRowCounts, seedPersonalRows, seedPersonalTargets } from '@peblish/core/testing/seed-b06';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { exportLedger, readLedgerExport, reapplyLedger } from './drill.ts';

// The restore replay of a local account deletion clears the personal tables again: a backup
// taken before the deletion brings the account's saves, pins, thread follows and visit markers
// back, and re-applying the ledger removes them, leaving everyone else's. Run on the lane's
// test database itself (no dump needed): the rows a backup would bring back are written again
// after the deletion, then the exported ledger is re-applied.

const url = process.env.DATABASE_URL ?? '';
const dir = mkdtempSync(join(tmpdir(), 'cutover-personal-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

test.each(personalTables.map((table) => getTableName(table)))(
  'the replay of an account deletion clears its %s rows again',
  async (name) => {
    const mira = await seedAccount('mira');
    const lena = await seedAccount('lena');
    const targets = await seedPersonalTargets(lena.actorId);
    const rows = { postId: targets.post.id, communityId: targets.community.id };
    await seedPersonalRows(lena.actorId, rows);

    const decision = await authorize(
      'account.delete',
      { kind: 'local', actorId: mira.actorId, siteRole: 'user' },
      { actorId: mira.actorId },
    );
    if (!decision.ok) throw new Error(decision.reason);
    await deleteAccount(decision.grant, { reason: 'owner request' });
    // What a backup from before the deletion holds for the account.
    await seedPersonalRows(mira.actorId, rows);
    expect((await personalRowCounts(mira.actorId))[name]).toBe(1);

    const file = join(dir, `${name}.json`);
    expect(await exportLedger(url, file)).toBe(1);
    expect(await reapplyLedger(url, readLedgerExport(file))).toMatchObject({ applied: 1, absent: 0 });

    expect((await personalRowCounts(mira.actorId))[name]).toBe(0);
    expect((await personalRowCounts(lena.actorId))[name]).toBe(1);
  },
);
