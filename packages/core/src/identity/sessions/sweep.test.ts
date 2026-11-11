import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../../db/read.ts';
import { authSession } from '../../db/tables/auth.ts';
import { writer } from '../../db/write.ts';
import { truncateAll } from '../../testing/db.ts';
import { seedAccount, seedLocalInstance } from '../../testing/seed-a.ts';
import { sessionTwoFactor } from '../tables.ts';
import { sweepExpiredSessions } from './sweep.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

test('expired sessions go in bounded batches, with their two-factor marks; live ones stay (B07 A5)', async () => {
  const mira = await seedAccount('mira');
  const now = Date.now();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    token: `expired-${i}`,
    userId: mira.userId,
    expiresAt: new Date(now - (i + 1) * 60_000),
    ipAddress: '203.0.113.7',
    userAgent: 'Firefox',
  }));
  const inserted = await writer()
    .insert(authSession)
    .values([...rows, { token: 'live', userId: mira.userId, expiresAt: new Date(now + 86_400_000) }])
    .returning({ id: authSession.id, token: authSession.token });
  await writer()
    .insert(sessionTwoFactor)
    .values(inserted.map(({ id }) => ({ sessionId: id })));

  // Two statements of two rows each: four go, one waits for the next run.
  expect(await sweepExpiredSessions({ batch: 2, maxBatches: 2 })).toBe(4);
  expect(await sweepExpiredSessions({ batch: 2, maxBatches: 2 })).toBe(1);
  expect(await sweepExpiredSessions({ batch: 2, maxBatches: 2 })).toBe(0);
  const left = await db().select({ token: authSession.token }).from(authSession).where(eq(authSession.userId, mira.userId));
  expect(left).toEqual([{ token: 'live' }]);
  expect(await db().select().from(sessionTwoFactor)).toHaveLength(1);
});
