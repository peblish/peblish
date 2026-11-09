import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readBundle, writeBundle } from './bundle.ts';
import { testBundle } from './test-bundle.ts';

test('a bundle is written with mode 600, never over an existing file and never inside the repository', async () => {
  const bundle = await testBundle();
  const dir = mkdtempSync(join(tmpdir(), 'cutover-bundle-'));
  try {
    const file = join(dir, 'bundle.json');
    writeBundle(file, bundle);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readBundle(file)).toEqual(bundle);
    expect(() => writeBundle(file, bundle)).toThrow(/EEXIST/);
    expect(() => writeBundle(join(import.meta.dirname, 'bundle.json'), bundle)).toThrow(/inside the repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
