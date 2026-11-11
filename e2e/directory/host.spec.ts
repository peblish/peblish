import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// A remote community's "local copy" line names the server the copy came from. Its username can
// hold an `@` and directional controls (e2e/directory/hostile-seed.ts), so the line must take the
// host after the last `@` and print it isolated, with no control character.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

test('the local copy line names the real host of a community whose name holds an @ and an override', async ({ page }) => {
  const hostile = JSON.parse(
    execFileSync('node', ['e2e/directory/hostile-seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { name: string; host: string; suffix: string };
  await gotoHydrated(page, `/communities?q=hostile_${hostile.suffix}`);
  const line = page
    .getByRole('row')
    .filter({ hasText: `hostile_${hostile.suffix}` })
    .getByText(/local copy/);
  await expect(line).toHaveText(new RegExp(`^${hostile.host.replaceAll('.', '\\.')} · local copy`));
  const drawn = await line.evaluate((element) => ({
    controls: /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(element.textContent!),
    isolated: element.querySelector('bdi')?.textContent,
  }));
  expect(drawn).toEqual({ controls: false, isolated: hostile.host });
});
