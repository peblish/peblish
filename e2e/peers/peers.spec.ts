import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { freshPage, seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane MODF end to end: the Peers tab. A new peer starts with its media quarantined; the admin
// approves it, purges it, pauses its inbox, blocks it and unblocks it, and blocks a host in advance.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: World;

/** A peer's row in the table, found by its host (the row header). */
const peerRow = (page: Page, host: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: host, exact: true }) });
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

  // The table reads; the peer's controls open below it from the row's Controls link.
  const row = peerRow(page, world.peer.domain);
  await expect(row.getByTestId('peer-media')).toHaveText('media quarantined');
  await row.getByRole('link', { name: `Controls for ${world.peer.domain}` }).click();
  const controls = page.getByTestId('peer-controls');
  await expect(controls.getByRole('heading', { name: `Controls for ${world.peer.domain}` })).toBeVisible();
  await expectAccessible(page);
  await controls.getByRole('button', { name: 'Approve media' }).click();
  await expect(row.getByTestId('peer-media')).toHaveText('media approved');
  await controls.getByRole('button', { name: 'Purge media' }).click();
  await expect(row.getByTestId('peer-media')).toHaveText('media purged');
  await expect(controls.getByRole('button', { name: 'Purge media' })).toBeDisabled();
  await controls.getByRole('button', { name: 'Pause inbox' }).click();
  await expect(row).toContainText('inbox paused');
  await controls.getByRole('button', { name: 'Resume inbox' }).click();
  await expect(row).not.toContainText('inbox paused');
  await controls.getByRole('textbox', { name: 'Reason (optional)' }).fill('Spam waves');
  await controls.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(row).toContainText('blocked');
  await expect(row).toContainText('Spam waves');

  // A blocked peer's posts leave the feeds; the post page is still reachable by its link.
  const visitor = await freshPage(browser);
  await gotoHydrated(visitor, '/all');
  await expect(visitor.getByText(`Remote post ${world.suffix}`)).toHaveCount(0);
  expect((await visitor.request.get(`/post/${world.posts.remote}`)).status()).toBe(200);
  await visitor.close();

  await controls.getByRole('button', { name: 'Unblock' }).click();
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
  const row = peerRow(page, host);
  await expect(row).toContainText('blocked');
  await expect(row).toContainText('media quarantined');
});

test('a member sees why they cannot use the Peers tab', async ({ page }) => {
  await signedIn(page, world, world.bystander.name);
  await gotoHydrated(page, '/admin/peers');
  await expect(page.getByRole('alert')).toContainText('Only site admins can manage peers.');
});
