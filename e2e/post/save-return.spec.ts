import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { signIn } from '../auth/support.ts';

// Save on the post page without scripts (post-page.tsx, the form in saved/-ui/save-form.tsx): the answer
// lands the reader back on the page as they had it, the thread's sort and page included, and not on an
// alert an earlier answer left in the address. The cast is packages/core/src/testing/seed-notify.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Cast = { password: string; reader: { name: string }; post: { id: string } };

let cast: Cast;
test.beforeAll(() => {
  test.setTimeout(120_000);
  const root = join(import.meta.dirname, '../..');
  cast = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-notify.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Cast;
});

async function plainPage(browser: Browser) {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto('/auth/sign-in');
  await signIn(page, `@${cast.reader.name}`, cast.password);
  await page.waitForURL('/');
  return page;
}

test('without scripts Save and Unsave land back on the thread’s sort, without a stale error', async ({ browser }) => {
  const page = await plainPage(browser);
  const here = `/post/${cast.post.id}?sort=new`;
  const at = new RegExp(`/post/${cast.post.id}\\?sort=new$`);
  await page.goto(here);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(at);
  await expect(page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();

  // An address that still carries an earlier refusal: the next answer does not bring it back.
  await page.goto(`${here}&error=form.invalid`);
  await page.getByRole('button', { name: 'Unsave', exact: true }).click();
  await expect(page).toHaveURL(at);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.context().close();
});
