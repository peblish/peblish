import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { db } from './read.ts';
import { inboxRaw } from './tables/federation.ts';
import { writer } from './write.ts';

// inbox_raw.body keeps a request body's exact bytes (the bytea column type in columns.ts):
// signature digests and the byte-for-byte relay depend on it.

beforeEach(truncateAll);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test.each([
  ['invalid UTF-8 and a NUL', new Uint8Array([0x00, 0xff, 0xc3, 0x28, 0x20, 0x0a])],
  ['JSON with trailing whitespace', new TextEncoder().encode('{"type":"Create","id":"https://lemmy.test/a/1"}  \n\t\n')],
  ['a Buffer', Buffer.from([0x7b, 0x7d, 0x0d, 0x0a, 0x00])],
])('%s round-trips byte for byte', async (_name, body) => {
  const [inserted] = await writer().insert(inboxRaw).values({ body }).returning({ id: inboxRaw.id });
  if (!inserted) throw new Error('no row inserted');
  const [row] = await db().select({ body: inboxRaw.body }).from(inboxRaw).where(eq(inboxRaw.id, inserted.id));
  const stored = row?.body;
  expect(stored).toBeInstanceOf(Uint8Array);
  if (!stored) throw new Error('no row');
  expect(stored.length).toBe(body.length);
  expect(Buffer.compare(Buffer.from(stored), Buffer.from(body))).toBe(0);
  expect(sha256(stored)).toBe(sha256(body));
});
