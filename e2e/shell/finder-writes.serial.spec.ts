import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Typing in the header's finder writes nothing: every request it makes is a read, none goes to the resolve form,
// and the outbox (the domain event log) has as many rows after a session of typing as before. Serial: the outbox
// count is the whole lane database's, which a spec running beside this one would change.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.setTimeout(90_000);

const root = join(import.meta.dirname, '../..');
const run = (...args: string[]) => JSON.parse(execFileSync('node', ['e2e/shell/finder-seed.ts', ...args], { cwd: root, encoding: 'utf8' }));

test('typing writes nothing: every request is a read, and the outbox gains no row', async ({ page }) => {
  const cast = run() as { password: string; person: string; word: string; host: string; communities: { kiln: { handle: string } } };
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${cast.person}`, cast.password);
  await landed(page, '/');
  await page.getByRole('banner').getByRole('link', { name: 'Find a community' }).click();
  const field = page.getByRole('dialog', { name: 'Find a community' }).getByRole('searchbox', { name: 'Find a community' });
  await expect(field).toBeFocused();
  const before = run('outbox').rows;
  const requests: { method: string; url: string }[] = [];
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
  for (const text of [cast.word, 'zzzz', cast.host, `!${cast.communities.kiln.handle}`, 'b']) {
    await field.fill('');
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(requests.filter(({ url }) => url.includes('/resolve'))).toEqual([]);
  expect(run('outbox').rows).toBe(before);
});
