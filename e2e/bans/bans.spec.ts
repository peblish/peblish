import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { freshPage, seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane MODF end to end: the Bans tab. The admin bans a person of a peer by handle after seeing
// what the ban would remove, the ban shows in the list and the public modlog, and Lift ends it.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: World;

/** A ban's row in the table, by the banned handle (the rows hold a link to the person). */
const banRow = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });
test.beforeAll(() => {
  world = seedWorld();
});

test('the admin bans a peer’s person by handle, sees it listed and in the public log, and lifts it', async ({ page, browser }) => {
  const console = recordConsole(page);
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/bans');
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Bans' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectAccessible(page);

  // An unknown handle is said so; a held one shows what the ban would remove.
  await page.getByLabel('Ban someone').fill('@nobody_here@nowhere.test');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('ban-missing')).toContainText('nobody_here@nowhere.test');
  await page.getByLabel('Ban someone').fill(`@${world.peer.person}`);
  await page.getByRole('button', { name: 'Check' }).click();
  const confirm = page.getByTestId('ban-confirm');
  await expect(confirm).toContainText(`Ban @${world.peer.person} from this instance?`);
  await expect(confirm).toContainText('posts: 1, comments: 0');
  await confirm.getByLabel('Length').selectOption('permanent');
  await confirm.getByLabel('Also remove their content').check();
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Ban evasion');
  await confirm.getByRole('button', { name: 'Ban', exact: true }).click();

  const row = banRow(page, world.peer.person);
  await expect(row).toContainText(world.peer.domain);
  await expect(row).toContainText('Ban evasion');
  await expect(row).toContainText('permanent');
  // Their post is removed with the ban, for everyone but a moderator.
  // The public log carries it, with the reason.
  const visitor = await freshPage(browser);
  const html = await (await visitor.request.get(`/post/${world.posts.remote}`)).text();
  expect(html).toContain('Removed by a moderator');
  expect(html).not.toContain(`Remote post ${world.suffix}`);
  await gotoHydrated(visitor, '/modlog');
  const entry = visitor.getByTestId('modlog-entry').filter({ hasText: world.peer.person });
  await expect(entry).toContainText('permanent');
  await expect(entry).toContainText('Ban evasion');
  await visitor.close();

  // Lift opens its panel below the table.
  await row.getByRole('link', { name: `Lift the ban on @${world.peer.person}` }).click();
  await page.getByTestId('ban-lift').getByRole('button', { name: 'Lift ban' }).click();
  await expect(banRow(page, world.peer.person)).toHaveCount(0);
  expect(console.hydrationProblems()).toEqual([]);
});

test('the admin bans a local bot (a Service actor) by handle, and lifts it', async ({ page }) => {
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/bans');
  await page.getByLabel('Ban someone').fill(`@${world.bot.name}`);
  await page.getByRole('button', { name: 'Check' }).click();
  const confirm = page.getByTestId('ban-confirm');
  await expect(confirm).toContainText(`Ban @${world.bot.name} from this instance?`);
  await confirm.getByLabel('Length').selectOption('permanent');
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Spam bot');
  await confirm.getByRole('button', { name: 'Ban', exact: true }).click();
  const row = banRow(page, world.bot.name);
  await expect(row).toContainText('Spam bot');
  await row.getByRole('link', { name: `Lift the ban on @${world.bot.name}` }).click();
  await page.getByTestId('ban-lift').getByRole('button', { name: 'Lift ban' }).click();
  await expect(banRow(page, world.bot.name)).toHaveCount(0);
});

test('a banned local person keeps reading and is refused every write', async ({ page, browser }) => {
  const admin = await freshPage(browser);
  await signedInAdmin(admin, world);
  await gotoHydrated(admin, '/admin/bans');
  await admin.getByLabel('Ban someone').fill(`@${world.spammer.name}`);
  await admin.getByRole('button', { name: 'Check' }).click();
  await admin.getByTestId('ban-confirm').getByRole('textbox', { name: 'Reason' }).fill('Spam');
  await admin.getByTestId('ban-confirm').getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(banRow(admin, world.spammer.name)).toBeVisible();
  await admin.close();

  await signedIn(page, world, world.spammer.name);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Author post');
  // The session cookie is Secure, so the request is made from the page, which has it.
  const answer = await page.evaluate(async (id) => {
    const response = await fetch(`/post/${id}/comments`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({ intent: 'reply', body: 'Still here' }),
    });
    return [response.status, await response.json()];
  }, world.posts.author);
  expect(answer).toEqual([400, { error: 'auth.site_banned' }]);
});

test('a member sees why they cannot use the Bans tab', async ({ page }) => {
  await signedIn(page, world, world.bystander.name);
  await gotoHydrated(page, '/admin/bans');
  await expect(page.getByRole('alert')).toContainText('Only site admins can manage bans.');
});
