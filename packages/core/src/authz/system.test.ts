import { createPublicKey, createSign, createVerify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { ensureLocalInstance } from '../db/bootstrap.ts';
import { db } from '../db/read.ts';
import { actorKeys, actors } from '../db/tables/actors.ts';
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

test('the instance actor gets its endpoints and one RSA-2048 keypair, idempotently', async () => {
  await ensureLocalInstance(writer(), 'https://feddit.test');
  const [instanceActor] = await db().select().from(actors).where(eq(actors.kind, 'Application'));
  expect(instanceActor).toMatchObject({
    apId: 'https://feddit.test/',
    inboxUrl: 'https://feddit.test/inbox',
    outboxUrl: 'https://feddit.test/outbox',
    sharedInboxUrl: 'https://feddit.test/inbox',
  });
  const [key] = await db().select().from(actorKeys);
  expect(key).toMatchObject({ actorId: instanceActor?.id, keyId: 'https://feddit.test/#main-key', algorithm: 'rsa' });
  expect(key?.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(key?.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  expect(createPublicKey(key!.publicKeyPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
  const signature = createSign('sha256').update('probe').sign(key!.privateKeyPem!);
  expect(createVerify('sha256').update('probe').verify(key!.publicKeyPem, signature)).toBe(true);

  await ensureLocalInstance(writer(), 'https://feddit.test');
  expect(await db().select().from(actorKeys)).toEqual([key]);
});

test('a re-run backfills endpoints an earlier bootstrap did not set, and keeps set ones', async () => {
  await ensureLocalInstance(writer(), 'https://feddit.test');
  await writer()
    .update(actors)
    .set({ inboxUrl: null, outboxUrl: 'https://feddit.test/custom-outbox', sharedInboxUrl: null })
    .where(eq(actors.kind, 'Application'));
  await ensureLocalInstance(writer(), 'https://feddit.test');
  const [instanceActor] = await db().select().from(actors).where(eq(actors.kind, 'Application'));
  expect(instanceActor).toMatchObject({
    inboxUrl: 'https://feddit.test/inbox',
    outboxUrl: 'https://feddit.test/custom-outbox',
    sharedInboxUrl: 'https://feddit.test/inbox',
  });
});
