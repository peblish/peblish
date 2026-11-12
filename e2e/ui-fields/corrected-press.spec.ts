import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { seedWorld, signedIn, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// A field corrected after a blocked submit keeps the next press on the submit button. The
// message under the field goes while the person types the fix, so nothing moves when they press
// the button. It used to go when the edit was committed, which for text is the blur that the
// press itself causes: the button moved up by the message's height between the press and the
// release, the release missed it, and nothing was sent (e2e/modlog/modlog.spec.ts on Linux CI).
//
// The press is a person's: down, a moment, up, at one point. The viewport is tall enough that
// these pages do not scroll, which is when the move was certain; scrolled to the bottom, the
// page's shrinking scrolled it up with the button and hid the fault.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

const viewport = { width: 1280, height: 1400 };
const message = 'Fill in this field.';

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

async function pageAs(browser: Browser, name?: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  if (name) await signedIn(page, world, name);
  return page;
}

/** Counts the posts a page sends. */
function posts(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') count++;
  });
  return () => count;
}

/** Presses the button as a person does, once it has settled, and checks it stayed where the press began. */
async function slowPress(page: Page, button: Locator): Promise<void> {
  // A panel that has just opened is still growing (its disclosure animates): wait until the
  // button holds still for 100 ms, as a person would, and is not covered.
  let last: number | undefined;
  await expect
    .poll(
      async () => {
        const y = (await button.boundingBox())?.y;
        const still = y !== undefined && y === last;
        last = y;
        return still;
      },
      { intervals: [100] },
    )
    .toBe(true);
  await button.click({ trial: true });
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  expect(await button.boundingBox()).toEqual(box);
  await page.mouse.up();
}

test('the modlog reason (text area): after the fix is typed, one press removes the comment', async ({ browser }) => {
  const page = await pageAs(browser, world.moderator.name);
  const sent = posts(page);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  const comment = page.locator(`#comment-${world.comments.spam}`);
  await comment.getByRole('button', { name: 'Remove comment', exact: true }).click();
  const remove = comment.getByRole('button', { name: 'Remove', exact: true });
  await remove.click();
  const reason = comment.getByRole('textbox', { name: 'Reason' });
  await expect(reason).toBeFocused();
  await expect(comment.getByRole('alert').filter({ hasText: message })).toHaveCount(1);
  // Typing the fix clears the message while the field still has focus.
  await reason.fill('Spam, affiliate links');
  await expect(comment.getByRole('alert')).toHaveCount(0);
  await expect(reason).toBeFocused();
  expect(sent()).toBe(0);
  await slowPress(page, remove);
  await expect(comment.getByRole('button', { name: 'Restore comment', exact: true })).toBeVisible();
  expect(sent()).toBe(1);
  await page.context().close();
});

test('the blocks handle (text field): after the fix is typed, one press blocks the person', async ({ browser }) => {
  const page = await pageAs(browser, world.bystander.name);
  const sent = posts(page);
  await gotoHydrated(page, '/settings/blocks');
  const handle = page.getByRole('textbox', { name: 'Block a person by handle' });
  const block = page.getByRole('button', { name: 'Block', exact: true });
  await block.click();
  await expect(handle).toBeFocused();
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(1);
  await handle.fill(`@${world.spammer.name}`);
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  expect(sent()).toBe(0);
  await slowPress(page, block);
  await expect(page.getByText(`Blocked @${world.spammer.name}.`)).toBeVisible();
  expect(sent()).toBe(1);
  await page.context().close();
});

test('sign-in (the auth field): after the fixes are typed, one press signs in', async ({ browser }) => {
  const page = await pageAs(browser);
  const sent = posts(page);
  await gotoHydrated(page, '/auth/sign-in');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await signIn.click();
  await expect(page.getByLabel('Email or handle')).toBeFocused();
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(2);
  await page.getByLabel('Email or handle').fill(`@${world.bystander.name}`);
  await page.getByLabel('Password', { exact: true }).fill(world.password);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(sent()).toBe(0);
  await slowPress(page, signIn);
  await page.waitForURL('/');
  expect(sent()).toBe(1);
  await page.context().close();
});
