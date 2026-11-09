import { expect, test } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { freshPage, seedWorld, signedIn, signedInAdmin, type World } from './support.ts';

// Lane MODF end to end, on the built server and the lane database: a moderator removes a
// comment and bans its author from the panels under the post (with and without JavaScript), and
// the modlog shows each audience what it may see. The steps share the seeded world, so they run
// in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

const postUrl = () => `/post/${world.posts.author}`;

test('a moderator removes a comment from the panel under it, then restores it', async ({ page }) => {
  const console = recordConsole(page);
  await signedIn(page, world, world.moderator.name);
  await gotoHydrated(page, postUrl());
  const comment = page.locator(`#comment-${world.comments.spam}`);
  await expect(comment).toContainText(`Buy now ${world.suffix}`);
  await comment.getByText('Remove comment', { exact: true }).click();
  // A reason is required: nothing is sent without one.
  await comment.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(comment.getByRole('textbox', { name: 'Reason' })).toBeFocused();
  await comment.getByRole('textbox', { name: 'Reason' }).fill('Spam, affiliate links');
  await comment.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(comment.getByText('Restore comment', { exact: true })).toBeVisible();
  await expect(comment).not.toContainText(`Buy now ${world.suffix}`);
  await comment.getByText('Restore comment', { exact: true }).click();
  await comment.getByRole('textbox', { name: 'Reason' }).fill('Removed by mistake');
  await comment.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(comment.getByText('Remove comment', { exact: true })).toBeVisible();
  await expect(comment).toContainText(`Buy now ${world.suffix}`);
  // The same removal again, to leave one public entry behind.
  await comment.getByText('Remove comment', { exact: true }).click();
  await comment.getByRole('textbox', { name: 'Reason' }).fill('Spam, affiliate links');
  await comment.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(comment.getByText('Restore comment', { exact: true })).toBeVisible();
  expect(console.hydrationProblems()).toEqual([]);
});

test('the moderator bans the author from the community and removes their content; the ban stays out of the public log when asked', async ({
  page,
}) => {
  await signedIn(page, world, world.moderator.name);
  await gotoHydrated(page, postUrl());
  const comment = page.locator(`#comment-${world.comments.spam}`);
  const panel = comment.getByTestId('mod-panel-ban');
  await panel.getByText(/^Ban from !/).click();
  await panel.getByLabel('Length').selectOption('7');
  await panel.getByLabel('Also remove their content').check();
  await panel.getByLabel('Show the reason in the public modlog').uncheck();
  await panel.getByRole('textbox', { name: 'Reason' }).fill('Rule 1: spam in three threads');
  await panel.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(panel.locator('form')).toBeHidden();
  // The spammer's post is removed: the moderator still sees it, with the notice, and everyone else gets the notice, not the post.
  await gotoHydrated(page, `/post/${world.posts.spam}`);
  await expect(page.getByText(/Removed\. Only moderators/)).toBeVisible();
  const stranger = await page.context().browser()!.newContext();
  const html = await (await stranger.request.get(`/post/${world.posts.spam}`)).text();
  expect(html).toContain('Removed by a moderator');
  expect(html).not.toContain(`Spam post ${world.suffix}`);
  await stranger.close();
});

test('the modlog shows the public log to a visitor and the private rows to the community’s moderator and to an admin', async ({
  browser,
}) => {
  const url = `/modlog?community=${world.community.handle}`;
  // Signed out: the two removals are public, the ban is not.
  const visitor = await freshPage(browser);
  await gotoHydrated(visitor, url);
  await expect(visitor.getByRole('heading', { name: 'Modlog', level: 1 })).toBeVisible();
  await expect(visitor.getByTestId('modlog-entry')).toHaveCount(3);
  await expect(visitor.getByTestId('modlog-entry').filter({ hasText: 'Removed comment' }).first()).toContainText('Spam, affiliate links');
  await expect(visitor.getByTestId('modlog-entry').filter({ hasText: 'Banned from community' })).toHaveCount(0);
  await expect(visitor.getByText('Moderator view')).toHaveCount(0);
  // The removed comment's text is not in the public log.
  await expect(visitor.locator('main')).not.toContainText(`Buy now ${world.suffix}`);
  await expectAccessible(visitor);
  await visitor.close();

  // The community's moderator sees the private ban, marked, and the Moderator view line.
  const moderator = await freshPage(browser);
  await signedIn(moderator, world, world.moderator.name);
  await gotoHydrated(moderator, url);
  await expect(moderator.getByTestId('modlog-entry')).toHaveCount(4);
  const ban = moderator.getByTestId('modlog-entry').filter({ hasText: 'Banned from community' });
  await expect(ban).toContainText('7 days');
  await expect(ban).toContainText('[mods only]');
  await expect(ban).toContainText('Rule 1: spam in three threads');
  await expect(ban).toContainText('content removed (posts: 1, comments: 0)');
  await expect(moderator.getByText('Moderator view')).toBeVisible();
  await expect(moderator.getByTestId('modlog-range')).toHaveText('1 to 4 of 4');
  // The rail narrows by action group and by remote copies.
  await moderator.getByRole('link', { name: /^Bans/ }).click();
  await moderator.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(moderator.getByTestId('modlog-entry')).toHaveCount(1);
  await moderator.getByRole('link', { name: /^Remote copies/ }).click();
  await expect(moderator.getByTestId('modlog-empty')).toContainText('No entries match these filters.');
  await moderator.close();

  // Another community's moderator would not see it, but an admin sees everything everywhere.
  const admin = await freshPage(browser);
  await signedInAdmin(admin, world);
  await gotoHydrated(admin, url);
  await expect(admin.getByTestId('modlog-entry').filter({ hasText: 'Banned from community' })).toHaveCount(1);
  await expectAccessible(admin);
  await admin.close();
});

test('with JavaScript off a panel is a plain form: the post answers 303 and a refusal opens the panel again', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email or handle').fill(`@${world.moderator.name}`);
  await page.getByLabel('Password', { exact: true }).fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
  await page.goto(postUrl());
  const comment = page.locator(`#comment-${world.comments.spam}`);
  await comment.getByText('Restore comment', { exact: true }).click();
  await comment.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(comment.getByText('Remove comment', { exact: true })).toBeVisible();
  // Meanwhile another moderator session removes it: the form this page still holds is refused with a code,
  // and the page comes back with that panel open and its message.
  await comment.getByText('Remove comment', { exact: true }).click();
  await comment.getByRole('textbox', { name: 'Reason' }).fill('Spam again');
  const second = await freshPage(browser);
  await signedIn(second, world, world.moderator.name);
  await gotoHydrated(second, postUrl());
  const there = second.locator(`#comment-${world.comments.spam}`);
  await there.getByText('Remove comment', { exact: true }).click();
  await there.getByRole('textbox', { name: 'Reason' }).fill('Spam');
  await there.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(there.getByText('Restore comment', { exact: true })).toBeVisible();
  await second.close();
  await comment.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForURL(new RegExp(`modError=target\\.removed`));
  await expect(page.locator(`#comment-${world.comments.spam}`).getByRole('alert')).toHaveText('That is already removed.');
  await context.close();
});

test('a member who moderates nothing cannot act: the form is refused and nothing changes', async ({ page }) => {
  await signedIn(page, world, world.bystander.name);
  await gotoHydrated(page, postUrl());
  await expect(page.getByText('Remove comment', { exact: true })).toHaveCount(0);
  // The session cookie is Secure, so the request is made from the page, which has it.
  const answer = await page.evaluate(
    async ({ id, back }) => {
      const response = await fetch('/modlog/act', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new URLSearchParams({ intent: 'remove', kind: 'post', id, reason: 'No', back }),
      });
      return [response.status, await response.json()];
    },
    { id: world.posts.author, back: postUrl() },
  );
  expect(answer).toEqual([400, { error: 'mod.moderator_required' }]);
});
