import { expect, test, type Page, type Request } from '@playwright/test';
import { seedWorld, signedIn as signedInModf, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { formUrl, plain, seedReports, signedIn, tick, type Seed } from './support.ts';

// The Report control and the form's forwarding, end to end on the built server: what happens when
// the dialog's code is slow or fails to load, where focus goes when the dialog closes, and how the
// routing line, the forward checkbox and the posted `forward` agree when the category changes.
// Its own worlds, so the reports it files never reach the queue specs in reports.spec.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: World;
let seed: Seed;
test.beforeAll(() => {
  world = seedWorld();
  seed = seedReports();
});

/** The lazily loaded module holding the Mux Dialog and the form. */
const dialogChunk = /\/assets\/report-dialog-[^/]+\.js$/;

/** A member who moderates nothing, on a post by someone else with a comment by a third person: two Report links. */
async function onThread(page: Page) {
  await signedInModf(page, world, world.bystander.name);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  const comment = page.locator(`#comment-${world.comments.spam}`).getByRole('link', { name: 'Report', exact: true });
  const post = page.getByRole('link', { name: 'Report', exact: true }).first();
  await expect(page.getByRole('link', { name: 'Report', exact: true })).toHaveCount(2);
  await expect(comment).toBeVisible();
  return { post, comment };
}

test.describe('the Report control', () => {
  test('a dialog chunk that fails to load falls back to the /report page', async ({ page }) => {
    const console = recordConsole(page);
    await page.route(dialogChunk, (route) => route.abort());
    const { post } = await onThread(page);
    await post.click();
    await page.waitForURL(/\/report\?kind=post&id=/);
    await expect(page.getByRole('heading', { name: 'Report this post' })).toBeVisible();
    expect(console.problems().filter(({ type }) => type === 'pageerror')).toEqual([]);
  });

  test('a slow dialog chunk: the clicked link is busy at once, a second Report takes over, and one dialog opens', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(dialogChunk, async (route) => {
      await held;
      await route.continue();
    });
    const { post, comment } = await onThread(page);
    await post.click();
    await expect(post).toHaveAttribute('data-opening', 'true');
    await comment.click();
    await expect(comment).toHaveAttribute('data-opening', 'true');
    await expect(post).not.toHaveAttribute('data-opening');
    release();
    const dialog = page.getByRole('dialog', { name: 'Report this comment' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Buy now ${world.suffix}`)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(comment).not.toHaveAttribute('data-opening');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The post's control gave way: nothing opens behind the closed dialog.
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(comment).toBeFocused();
  });

  test('closing the dialog returns focus to the Report link, by Cancel, by Escape and from the keyboard', async ({ page }) => {
    const { post, comment } = await onThread(page);
    await post.click();
    const dialog = page.getByRole('dialog', { name: 'Report this post' });
    await expect(dialog.getByRole('button', { name: 'Send report' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(post).toBeFocused();
    await comment.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Report this comment' }).getByRole('button', { name: 'Send report' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(comment).toBeFocused();
  });
});

/**
 * Forwarding chosen, then a category that cannot be forwarded: the routing line says admins only,
 * the forward checkbox goes away, and the report is not forwarded. Back to a category that can be
 * forwarded, the checkbox is there again as it was left.
 */
async function forwardThenChange(page: Page) {
  const forward = page.getByRole('checkbox', {
    name: `Also send to the moderators of ${seed.farHost}. They will see the report and your handle.`,
  });
  const moderators = page.getByText(/The moderators of this community and the instance admins will see your report/);
  const admins = page.getByText(/Only the instance admins will see this report/);
  // Mux draws the checkbox over a visually hidden input, so whether it shows is read from its label.
  const shown = forward.locator('xpath=ancestor::label[1]');
  await tick(page.getByRole('radio', { name: /^Spam/ }));
  await expect(moderators).toBeVisible();
  await expect(shown).toBeVisible();
  await tick(forward);
  await tick(page.getByRole('radio', { name: /^Copyright/ }));
  await expect(admins).toBeVisible();
  await expect(moderators).toBeHidden();
  await expect(shown).toBeHidden();
  await tick(page.getByRole('radio', { name: /^Hate/ }));
  await expect(moderators).toBeVisible();
  await expect(shown).toBeVisible();
  await expect(forward).toBeChecked();
  await tick(page.getByRole('radio', { name: /^Copyright/ }));
  await expect(shown).toBeHidden();
}

/** The fields of the report form's post, however it was sent (a plain post or a fetch). */
function postedReport(page: Page) {
  let sent: Request | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/report') sent = request;
  });
  return () => new URLSearchParams(sent?.postData() ?? '');
}

/** The receipt of a report that stayed here: the anonymity promise, and no host that can see it. */
async function notForwarded(page: Page) {
  await expect(page).toHaveURL(/\/report\/sent\?n=\d+/);
  await expect(page.getByText(/will not learn who you are/)).toBeVisible();
  await expect(page.getByText(/can also see the report/)).toHaveCount(0);
}

test.describe('forwarding, then another category', () => {
  test('with JavaScript the hidden checkbox is not posted, and the report is not forwarded', async ({ page }) => {
    await signedIn(page, seed, seed.second.name);
    await gotoHydrated(page, formUrl(seed.posts.forwarded));
    const posted = postedReport(page);
    await forwardThenChange(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await notForwarded(page);
    expect(posted().get('category')).toBe('copyright');
    expect(posted().has('forward')).toBe(false);
  });

  test('without JavaScript the server drops a forward the category cannot take, and the report is not forwarded', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed, seed.outsider.name);
    await page.goto(formUrl(seed.posts.forwarded));
    const posted = postedReport(page);
    await forwardThenChange(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await notForwarded(page);
    // CSS hides the checkbox but cannot keep a hidden field out of a plain post; createReport's
    // caller (routes/report/index.tsx) forwards only a category that may federate.
    expect(posted().get('category')).toBe('copyright');
    expect(posted().get('forward')).toBe('yes');
  });
});
