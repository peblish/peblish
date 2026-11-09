import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { remoteMedia } from '../../packages/core/src/testing/seed-safe.ts';

// The remote-media pause switch (lane SAFE). It flips remote_media.enabled on the lane database,
// which every page that renders a remote image reads, so it runs in the serial project, after
// the parallel one.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database and bucket for its seeds');

const root = join(import.meta.dirname, '../..');
const seed = <T>(...args: string[]): T =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-safe.ts', ...args], { cwd: root, encoding: 'utf8' })) as T;

test.afterAll(async () => {
  await closePools();
});

test('the remote-media pause switch stops the proxy but not a clean upload', async ({ request }) => {
  const rows = seed<Record<'clean', string>>('states');
  const proxy = execFileSync('node', ['packages/core/src/testing/seed-b2.ts', 'proxy-path', 'https://img.example/a.png'], {
    cwd: root,
    encoding: 'utf8',
  });
  await remoteMedia(false);
  let proxied;
  let clean;
  try {
    proxied = await request.get(JSON.parse(proxy) as string);
    clean = await request.get(`/media/${rows.clean}`);
  } finally {
    await remoteMedia(true);
  }
  expect([proxied.status(), proxied.headers()['cache-control']]).toEqual([404, 'no-store']);
  expect(clean.status()).toBe(200);
});
