import { uuidv7 } from 'uuidv7';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { authVerification } from '../db/tables/auth.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { putFlash, takeFlash } from './flash.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

test('a flash reaches its own session once, and is not stored in the clear', async () => {
  const [mine, other] = [uuidv7(), uuidv7()];
  await putFlash(mine, 'invite', 'PB-7K2Q-XM4D');
  expect(JSON.stringify(await db().select().from(authVerification))).not.toContain('7K2Q');
  expect(await takeFlash(other, 'invite')).toBeNull();
  expect(await takeFlash(mine, 'invite')).toBe('PB-7K2Q-XM4D');
  expect(await takeFlash(mine, 'invite')).toBeNull();
});
