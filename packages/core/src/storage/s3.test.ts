import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { memoryStore } from './memory.ts';
import { s3Store } from './s3.ts';
import { assertKey } from './store.ts';

test('keys are plain path segments: no traversal, no empty, dot or odd segments', () => {
  for (const key of ['media/0190a.png', 'uploads/2026/a-b_c.webp', 'a']) expect(() => assertKey(key)).not.toThrow();
  for (const key of ['', '/a', 'a/', 'a//b', 'a/./b', 'a/../b', '../a', '.hidden', 'a b', 'a?x=1', 'a%2Fb', 'é', `${'a'.repeat(513)}`]) {
    expect(() => assertKey(key), JSON.stringify(key.slice(0, 20))).toThrow(TypeError);
  }
});

test('the in-memory store used by tests keeps the same contract', async () => {
  const store = memoryStore();
  await store.put('a/b.png', new Uint8Array([1, 2, 3]), 'image/png');
  expect(await store.get('a/b.png')).toEqual({ body: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
  await store.delete('a/b.png');
  await store.delete('a/b.png');
  expect(await store.get('a/b.png')).toBeNull();
});

test('a bucket that never answers is abandoned: every call times out instead of hanging', async () => {
  // A server that accepts the request and says nothing.
  const server = http.createServer(() => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const config = {
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      S3_BUCKET: 'timeouts',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    };
    const store = s3Store(config, { timeoutMs: 150 });
    const started = Date.now();
    for (const call of [
      () => store.put('test/slow.bin', new Uint8Array([1]), 'application/octet-stream'),
      () => store.get('test/slow.bin'),
      () => store.delete('test/slow.bin'),
      () => store.ensureBucket(),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

// Needs the MinIO of compose.yaml and the S3_* variables: scripts/lane.sh exports them for a lane, and CI starts the same
// image and sets them (.github/workflows/ci.yml), so the suite is skipped only when they are missing.
describe.skipIf(!process.env.S3_ENDPOINT)('the S3 adapter against MinIO', () => {
  test('puts, gets and deletes an object, and creates its bucket when missing', async () => {
    const store = s3Store();
    await store.ensureBucket();
    await store.ensureBucket();
    const key = `test/${randomUUID()}.bin`;
    const body = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    expect(await store.get(key)).toBeNull();
    await store.put(key, body, 'application/octet-stream');
    expect(await store.get(key)).toEqual({ body, contentType: 'application/octet-stream' });
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
  });

  test('wrong credentials fail loudly', async () => {
    const store = s3Store({ ...configFromEnv(), S3_SECRET_ACCESS_KEY: 'not-the-secret' });
    await expect(store.put('test/denied.bin', new Uint8Array([1]), 'application/octet-stream')).rejects.toThrow(/403/);
  });
});

function configFromEnv() {
  const { S3_ENDPOINT = '', S3_BUCKET = '', S3_REGION = '', S3_ACCESS_KEY_ID = '', S3_SECRET_ACCESS_KEY = '' } = process.env;
  return { S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY };
}
