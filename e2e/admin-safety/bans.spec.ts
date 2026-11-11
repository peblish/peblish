import { expect, test, type Page } from '@playwright/test';
import { freshPage, seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { enterDoesNothing, postsTo, tick, withoutScripts } from './support.ts';

// The Bans tab's two panels: a choice made for one person ("Also remove their content", a reason,
// the public switch) never carries over to another, Enter in a field bans or lifts nothing, and
// only one ban named in the address opens the Lift panel.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
// Each test signs in and walks several pages; other lanes share this machine, so allow for load.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

const banRow = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

async function check(page: Page, name: string) {
  await page.getByLabel('Ban someone').fill(`@${name}`);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('ban-confirm')).toContainText(`Ban @${name} from this instance?`);
  return page.getByTestId('ban-confirm');
}

async function ban(page: Page, name: string, reason: string) {
  const confirm = await check(page, name);
  await confirm.getByRole('textbox', { name: 'Reason' }).fill(reason);
  await confirm.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(banRow(page, name)).toContainText(reason);
}

/** The person id a ban's Lift link carries. */
async function liftId(page: Page, name: string) {
  const href = await banRow(page, name)
    .getByRole('link', { name: `Lift the ban on @${name}` })
    .getAttribute('href');
  return new URL(href!, 'http://local').searchParams.get('lift')!;
}

test('“Also remove their content” for one person does not carry over to the next, and Enter bans nobody', async ({ page, browser }) => {
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/bans');
  let confirm = await check(page, world.bystander.name);
  const removeContent = () => confirm.getByRole('checkbox', { name: /^Also remove their content/ });
  await tick(removeContent(), true);
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('about the bystander');

  confirm = await check(page, world.author.name);
  await expect(removeContent()).not.toBeChecked();
  await expect(confirm.getByRole('textbox', { name: 'Reason' })).toHaveValue('');

  // With a reason in, Enter on the checkbox or in the date field still bans nobody.
  const sent = postsTo(page, '/modlog/act');
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Off-topic flooding');
  await enterDoesNothing(page, removeContent(), sent);
  await enterDoesNothing(page, confirm.getByLabel('Ends on'), sent);
  await expect(banRow(page, world.author.name)).toHaveCount(0);

  await confirm.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(banRow(page, world.author.name)).toContainText('Off-topic flooding');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('intent')).toBe('site_ban');
  expect(sent[0]!.has('removeContent')).toBe(false);
  const visitor = await freshPage(browser);
  const html = await (await visitor.request.get(`/post/${world.posts.author}`)).text();
  expect(html).toContain('Author post');
  expect(html).not.toContain('Removed by a moderator');
  await visitor.context().close();
});

test('without scripts, Enter in the ban panel bans nobody and comes back to the panel', async ({ page, browser }) => {
  await signedInAdmin(page, world);
  const plain = await withoutScripts(page, browser);
  const sent = postsTo(plain, '/modlog/act');
  const panel = `/admin/bans?${new URLSearchParams({ person: `@${world.moderator.name}` })}`;
  // The find field's Enter is its own form's Check, which only looks the person up again.
  for (const field of ['date', 'checkbox', 'find'] as const) {
    await plain.goto(panel);
    const confirm = plain.getByTestId('ban-confirm');
    await expect(confirm).toContainText(`Ban @${world.moderator.name} from this instance?`);
    await confirm.getByRole('textbox', { name: 'Reason' }).fill('typed without scripts');
    const target =
      field === 'date'
        ? confirm.getByLabel('Ends on')
        : field === 'checkbox'
          ? confirm.getByRole('checkbox', { name: /^Also remove their content/ })
          : plain.getByLabel('Ban someone');
    await target.focus();
    await plain.keyboard.press('Enter');
    await plain.waitForLoadState();
    await expect(plain.getByTestId('ban-confirm'), field).toContainText(`Ban @${world.moderator.name} from this instance?`);
    expect(sent, field).toHaveLength(0);
  }
  await expect(plain.getByRole('row').filter({ hasText: world.moderator.name })).toHaveCount(0);
  await plain.context().close();
});

test('switching Lift panels keeps each one’s reason and switch to itself, and Enter lifts nothing', async ({ page }) => {
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/bans');
  await ban(page, world.spammer.name, 'Spam');
  await ban(page, world.bot.name, 'Spam bot');
  const botId = await liftId(page, world.bot.name);

  const lift = page.getByTestId('ban-lift');
  const reason = lift.getByRole('textbox', { name: 'Reason' });
  const show = lift.getByRole('checkbox', { name: 'Show the reason in the public modlog' });
  await banRow(page, world.spammer.name)
    .getByRole('link', { name: `Lift the ban on @${world.spammer.name}` })
    .click();
  await expect(lift.getByRole('heading')).toHaveText(`Lift the ban on @${world.spammer.name}?`);
  await reason.fill('about the spammer');
  await tick(show, false);
  const sent = postsTo(page, '/modlog/act');
  await enterDoesNothing(page, show, sent);

  await banRow(page, world.bot.name)
    .getByRole('link', { name: `Lift the ban on @${world.bot.name}` })
    .click();
  await expect(lift.getByRole('heading')).toHaveText(`Lift the ban on @${world.bot.name}?`);
  await expect(reason).toHaveValue('');
  await expect(show).toBeChecked();
  await lift.getByRole('button', { name: 'Lift ban' }).click();
  await expect(banRow(page, world.bot.name)).toHaveCount(0);
  await expect(banRow(page, world.spammer.name)).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('intent')).toBe('site_unban');
  expect(sent[0]!.get('person')).toBe(botId);
});

test('the address opens the Lift panel of one ban in the list and nothing else', async ({ page, browser }) => {
  await signedInAdmin(page, world);
  const console = recordConsole(page);
  await gotoHydrated(page, '/admin/bans');
  const spammer = await liftId(page, world.spammer.name);
  const author = await liftId(page, world.author.name);
  const lift = page.getByTestId('ban-lift');
  const missing = page.getByTestId('lift-missing');

  // Two bans at once: nothing opens (the server reads them as one id with a comma, which matches none).
  await gotoHydrated(page, `/admin/bans?lift=${spammer}&lift=${author}`);
  await expect(page.getByTestId('bans-table')).toBeVisible();
  await expect(lift).toHaveCount(0);

  // A lift and a refusal that disagree, an empty or an object selector: nothing opens, nothing is said.
  for (const search of [`lift=${spammer}&modFor=site_unban:${author}`, `lift=`, `lift[id]=${spammer}`]) {
    await gotoHydrated(page, `/admin/bans?${search}`);
    await expect(page.getByTestId('bans-table')).toBeVisible();
    await expect(lift, search).toHaveCount(0);
    await expect(missing, search).toHaveCount(0);
  }

  // A ban that is not in the list (gone, never there, not an id): nothing opens, and a notice says so.
  for (const id of ['01900000-0000-7000-8000-000000000000', '12345', spammer.toUpperCase()]) {
    await gotoHydrated(page, `/admin/bans?lift=${id}`);
    await expect(lift, id).toHaveCount(0);
    await expect(missing, id).toHaveText('That ban is not in the list. It may have been lifted already.');
  }

  // The ban itself, by lift or by a refusal for its panel, opens its own panel.
  for (const search of [`lift=${spammer}`, `modFor=site_unban:${spammer}`, `lift=${spammer}&modFor=site_unban:${spammer}`]) {
    await gotoHydrated(page, `/admin/bans?${search}`);
    await expect(lift, search).toHaveCount(1);
    await expect(lift.getByRole('heading'), search).toHaveText(`Lift the ban on @${world.spammer.name}?`);
    await expect(lift.locator('input[name="person"]')).toHaveValue(spammer);
  }
  expect(console.hydrationProblems()).toEqual([]);

  // Without scripts, Enter on the Lift panel's switch lifts nothing and comes back to the panel.
  const plain = await withoutScripts(page, browser);
  const sent = postsTo(plain, '/modlog/act');
  await plain.goto(`/admin/bans?lift=${spammer}`);
  await plain.getByTestId('ban-lift').getByRole('checkbox', { name: 'Show the reason in the public modlog' }).focus();
  await plain.keyboard.press('Enter');
  await plain.waitForLoadState();
  await expect(plain.getByTestId('ban-lift').getByRole('heading')).toHaveText(`Lift the ban on @${world.spammer.name}?`);
  expect(sent).toHaveLength(0);
  await expect(banRow(plain, world.spammer.name)).toBeVisible();
  await plain.context().close();
});
