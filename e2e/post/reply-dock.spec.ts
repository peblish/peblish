import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The thread's docked reply on the lane database: a refused reply can be sent again, by Send and by
// Ctrl+Enter, while an empty one is still held back; and moving into the dock by keyboard keeps the
// reader where they are in the thread.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  replier: { name: string };
  posts: { thread: string };
  comments: { first: string; second: string; third: string };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-d.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const postUrl = (id: string) => `/post/${id}`;

async function signedIn(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.replier.name}`, seed.password);
  await landed(page, '/');
}

test('a refused reply can be sent again, by Send and by Ctrl+Enter; an empty one is still held back', async ({ page }) => {
  await signedIn(page);
  // Every reply this page sends is refused, so nothing is written and each attempt is counted.
  let sent = 0;
  await page.route(`**${postUrl(seed.posts.thread)}/comments`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent += 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'rate.limited' }) });
  });
  await gotoHydrated(page, postUrl(seed.posts.thread));
  const dock = page.getByRole('form', { name: 'Reply' });
  const field = dock.getByRole('textbox', { name: 'Reply' });
  const send = dock.getByRole('button', { name: 'Reply' });
  const refusal = 'You are commenting too fast. Wait a few minutes and try again.';

  // Empty, nothing goes: the browser's own check says why, and a blank one is held back too.
  await send.click();
  await expect(dock.getByRole('alert')).toHaveText('Fill in this field.');
  await field.fill('   ');
  await send.click();
  expect(sent).toBe(0);

  await field.fill(`A reply ${seed.suffix}`);
  await send.click();
  await expect(dock.getByRole('alert')).toHaveText(refusal);
  await expect.poll(() => sent).toBe(1);
  // The refusal marks the field invalid; Send still goes, and so does the shortcut after an edit.
  await send.click();
  await expect.poll(() => sent).toBe(2);
  await field.press('End');
  await field.press('!');
  await field.press('ControlOrMeta+Enter');
  await expect.poll(() => sent).toBe(3);
  await expect(field).toHaveValue(`A reply ${seed.suffix}!`);
  await expect(dock.getByRole('alert')).toHaveText(refusal);

  // An empty draft is still held back while the refusal shows.
  await field.fill('');
  await send.click();
  await field.press('ControlOrMeta+Enter');
  await page.waitForTimeout(200);
  expect(sent).toBe(3);
});
