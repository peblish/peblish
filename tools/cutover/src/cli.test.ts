import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { siteSettings } from '@peblish/core/db/tables/site';
import { writer } from '@peblish/core/db/write';
import { readSetting } from '@peblish/core/settings/read';
import { truncateAll } from '@peblish/core/testing/db';
import { afterAll, expect, test } from 'vitest';
import { testOrigin } from './test-bundle.ts';

// The CLI's import, run as the runbook runs it (node tools/cutover/src/cli.ts import --bundle
// <file>): the federation switch goes off, committed, before the file is read, so a bundle that
// is missing, not JSON or of the wrong shape leaves it off.

const dir = mkdtempSync(join(tmpdir(), 'cutover-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(...args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(import.meta.dirname, 'cli.ts'), ...args],
      { env: { ...process.env, PUBLIC_ORIGIN: testOrigin }, timeout: 60_000 },
      (error, _stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr }),
    );
  });
}

const bundles = {
  missing: { write: false, text: '', says: /ENOENT/ },
  'not JSON': { write: true, text: '{"format": "peblish.cutover/1",', says: /^the bundle is not valid JSON/ },
  'of the wrong shape': { write: true, text: '{"format": "peblish.cutover/1"}', says: /^the bundle does not match its format/ },
};

test.each(Object.entries(bundles))(
  'import of a bundle file that is %s turns the federation switch off and imports nothing',
  { timeout: 90_000 },
  async (name, bundle) => {
    await truncateAll();
    await writer().insert(siteSettings).values({ key: 'delivery.enabled', value: true });
    const file = join(dir, `${name.replaceAll(' ', '-')}.json`);
    if (bundle.write) writeFileSync(file, bundle.text, { mode: 0o600 });

    const { code, stderr } = await cli('import', '--bundle', file);
    expect(code).toBe(1);
    expect(stderr.trim()).toMatch(bundle.says);
    expect(await readSetting('delivery.enabled')).toBe(false);
    expect(await db().select({ id: actors.id }).from(actors)).toEqual([]);
  },
);
