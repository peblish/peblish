import { expect, test } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { freshPage, seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane MODF end to end: the Peers tab. A new peer starts with its media quarantined; the admin
// approves it, purges it, pauses its inbox, blocks it and unblocks it, and blocks a host in advance.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

test('the admin works through a peer’s controls', async ({ page, browser }) => {
  const console = recordConsole(page);
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/peers');
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Peers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectAccessible(page);

  const row = page.locator(`[data-testid="peer-row"][data-domain="${world.peer.domain}"]`);
  await expect(row.getByTestId('peer-media')).toHaveText('media quarantined');
  await row.getByRole('button', { name: 'Approve media' }).click();
  await expect(row.getByTestId('peer-media')).toHaveText('media approved');
  await row.getByRole('button', { name: 'Purge media' }).click();
  await expect(row.getByTestId('peer-media')).toHaveText('media purged');
  await expect(row.getByRole('button', { name: 'Purge media' })).toBeDisabled();
  await row.getByRole('button', { name: 'Pause inbox' }).click();
  await expect(row).toContainText('inbox paused');
  await row.getByRole('button', { name: 'Resume inbox' }).click();
  await expect(row).not.toContainText('inbox paused');
  await row.getByRole('textbox').fill('Spam waves');
  await row.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(row).toContainText('blocked');
  await expect(row).toContainText('Spam waves');

  // A blocked peer's posts leave the feeds; the post page is still reachable by its link.
  const visitor = await freshPage(browser);
  await gotoHydrated(visitor, '/all');
  await expect(visitor.getByText(`Remote post ${world.suffix}`)).toHaveCount(0);
  expect((await visitor.request.get(`/post/${world.posts.remote}`)).status()).toBe(200);
  await visitor.close();

  await row.getByRole('button', { name: 'Unblock' }).click();
  await expect(row).not.toContainText('blocked');

  // The changes are in the modlog for the admin and never in the public log.
  await gotoHydrated(page, '/modlog?action=site');
  await expect(page.getByTestId('modlog-entry').filter({ hasText: world.peer.domain }).first()).toContainText('Changed peer controls');
  const visitorLog = await freshPage(browser);
  await gotoHydrated(visitorLog, '/modlog');
  await expect(visitorLog.getByText('Changed peer controls')).toHaveCount(0);
  await visitorLog.close();
  expect(console.hydrationProblems()).toEqual([]);
});

test('a host can be blocked before it is ever seen, and a bad host is refused', async ({ page }) => {
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/peers');
  const host = `ahead-${world.suffix}.example`;
  await page.getByLabel('Block a host').fill('not a host');
  await page.getByRole('button', { name: 'Block', exact: true }).first().click();
  await expect(page.getByRole('alert')).toHaveText('That is not a valid host name.');
  await page.getByLabel('Block a host').fill(`https://${host}/somewhere`);
  await page.getByRole('button', { name: 'Block', exact: true }).first().click();
  const row = page.locator(`[data-testid="peer-row"][data-domain="${host}"]`);
  await expect(row).toContainText('blocked');
  await expect(row).toContainText('media quarantined');
});

test('a member sees why they cannot use the Peers tab', async ({ page }) => {
  await signedIn(page, world, world.bystander.name);
  await gotoHydrated(page, '/admin/peers');
  await expect(page.getByRole('alert')).toContainText('Only site admins can manage peers.');
});
