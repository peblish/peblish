import { expect, test, type Page } from '@playwright/test';
import { seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { enterDoesNothing, postFromPage, postsTo, withoutScripts } from './support.ts';

// The Peers tab's Controls card: Enter in its reason box changes nothing (its first button is
// Approve media), with scripts on and off; the server refuses a post with no change or an unknown
// one; the card posts for the host it names; and only one known host in the address opens one.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
// Each test signs in and walks several pages; other lanes share this machine, so allow for load.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let one: World;
let two: World;
test.beforeAll(() => {
  one = seedWorld();
  two = seedWorld();
});

const peerRow = (page: Page, host: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: host, exact: true }) });
const controlsHref = (host: string) => `/admin/peers?${new URLSearchParams({ peer: host })}`;

test('Enter in a peer’s reason approves nothing, with scripts on and off', async ({ page, browser }) => {
  await signedInAdmin(page, one);
  await gotoHydrated(page, controlsHref(one.peer.domain));
  const controls = page.getByTestId('peer-controls');
  await expect(controls.getByRole('button', { name: 'Approve media' })).toBeVisible();
  const sent = postsTo(page, '/admin/peers');
  const reason = controls.getByRole('textbox', { name: 'Reason (optional)' });
  await reason.fill('typing a reason');
  await enterDoesNothing(page, reason, sent);
  await expect(peerRow(page, one.peer.domain).getByTestId('peer-media')).toHaveText('media quarantined');

  const plain = await withoutScripts(page, browser);
  const plainSent = postsTo(plain, '/admin/peers');
  await plain.goto(controlsHref(one.peer.domain));
  const plainReason = plain.getByTestId('peer-controls').getByRole('textbox', { name: 'Reason (optional)' });
  await plainReason.fill('typing without scripts');
  await enterDoesNothing(plain, plainReason, plainSent);
  await plain.reload();
  await expect(peerRow(plain, one.peer.domain).getByTestId('peer-media')).toHaveText('media quarantined');
  await plain.context().close();
});

test('a post with no change, or one the server does not know, is refused', async ({ page }) => {
  await signedInAdmin(page, one);
  await gotoHydrated(page, '/admin/peers');
  const refused: Record<string, string>[] = [
    { domain: one.peer.domain, reason: 'no intent' },
    { domain: one.peer.domain, intent: '' },
    { domain: one.peer.domain, intent: 'approve-all' },
    { domain: one.peer.domain, intent: 'APPROVE' },
  ];
  for (const fields of refused) {
    const answer = await postFromPage(page, '/admin/peers', fields);
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('"error"');
  }
  await page.reload();
  await expect(peerRow(page, one.peer.domain).getByTestId('peer-media')).toHaveText('media quarantined');
});

test('switching Controls cards posts for the host the card names', async ({ page }) => {
  await signedInAdmin(page, one);
  await gotoHydrated(page, '/admin/peers');
  const controls = page.getByTestId('peer-controls');
  const reason = controls.getByRole('textbox', { name: 'Reason (optional)' });
  await peerRow(page, one.peer.domain)
    .getByRole('link', { name: `Controls for ${one.peer.domain}` })
    .click();
  await expect(controls.getByRole('heading')).toHaveText(`Controls for ${one.peer.domain}`);
  await reason.fill(`about ${one.peer.domain}`);

  await peerRow(page, two.peer.domain)
    .getByRole('link', { name: `Controls for ${two.peer.domain}` })
    .click();
  await expect(controls.getByRole('heading')).toHaveText(`Controls for ${two.peer.domain}`);
  await expect(reason).toHaveValue('');
  const sent = postsTo(page, '/admin/peers');
  await controls.getByRole('button', { name: 'Pause inbox' }).click();
  await expect(peerRow(page, two.peer.domain)).toContainText('inbox paused');
  await expect(peerRow(page, one.peer.domain)).not.toContainText('inbox paused');
  expect(sent).toHaveLength(1);
  expect(Object.fromEntries(sent[0]!)).toEqual({ domain: two.peer.domain, reason: '', intent: 'pause' });
  await controls.getByRole('button', { name: 'Resume inbox' }).click();
  await expect(peerRow(page, two.peer.domain)).not.toContainText('inbox paused');
});

test('the address opens the Controls of one known host and nothing else', async ({ page }) => {
  await signedInAdmin(page, one);
  const console = recordConsole(page);
  const controls = page.getByTestId('peer-controls');
  const missing = page.getByTestId('peer-missing');

  // No host, or no `peer` key at all: no card and no notice.
  for (const search of ['peer=', `peer[domain]=${one.peer.domain}`]) {
    await gotoHydrated(page, `/admin/peers?${search}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Peers');
    await expect(controls, search).toHaveCount(0);
    await expect(missing, search).toHaveCount(0);
  }

  // Anything else that is not exactly a host in the list (two hosts at once, which the server reads
  // as one name with a comma; an object; a number; another case; a space): no card, and a notice.
  for (const search of [
    `peer=${one.peer.domain}&peer=${two.peer.domain}`,
    `peer=${encodeURIComponent(JSON.stringify({ domain: one.peer.domain }))}`,
    'peer=12345',
    `peer=nowhere-${one.suffix}.example`,
    `peer=${one.peer.domain.toUpperCase()}`,
    `peer=%20${one.peer.domain}`,
  ]) {
    await gotoHydrated(page, `/admin/peers?${search}`);
    await expect(missing, search).toBeVisible();
    await expect(controls, search).toHaveCount(0);
  }
  // toHaveText folds the leading space of the last one.
  await expect(missing).toHaveText(`No peer ${one.peer.domain} is in the list.`);
  // The same without scripts.
  const html = await page.evaluate(async (href) => (await fetch(href)).text(), controlsHref(`nowhere-${one.suffix}.example`));
  expect(html).toContain(`No peer nowhere-${one.suffix}.example is in the list.`);
  expect(html).not.toContain('data-testid="peer-controls"');

  // The host itself opens its own card, and only that one.
  await gotoHydrated(page, controlsHref(two.peer.domain));
  await expect(controls).toHaveCount(1);
  await expect(controls.getByRole('heading')).toHaveText(`Controls for ${two.peer.domain}`);
  await expect(controls.locator('input[name="domain"]')).toHaveValue(two.peer.domain);
  expect(console.hydrationProblems()).toEqual([]);
});
