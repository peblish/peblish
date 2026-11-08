import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { ensureLocalInstance } from '../db/bootstrap.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { authorize } from './authorize.ts';
import { systemPrincipal } from './system.ts';

beforeEach(truncateAll);

test('migrate creates one instance actor, and system work runs as it', async () => {
  await ensureLocalInstance(writer(), 'https://feddit.test');
  await ensureLocalInstance(writer(), 'https://feddit.test');
  await expect(ensureLocalInstance(writer(), 'https://elsewhere.test')).rejects.toThrow(/local instance is https:\/\/feddit.test;/);
  const instanceActors = await db().select().from(actors).where(eq(actors.kind, 'Application'));
  expect(instanceActors).toMatchObject([{ apId: 'https://feddit.test/', name: 'feddit.test', local: true }]);

  const principal = await systemPrincipal(db(), 'import');
  expect(principal).toEqual({ kind: 'system', actorId: instanceActors[0]?.id, job: 'import' });
  // Policies decide what the system may do; post.create is for local people only.
  expect(await authorize('post.create', principal, { communityId: principal.actorId })).toEqual({ ok: false, reason: 'auth.required' });
});
