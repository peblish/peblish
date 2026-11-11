import { expect, test, type Locator, type Page } from '@playwright/test';
import { postsTo } from '../admin-safety/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { seedWorld, signedIn, type World } from './support.ts';

// A refusal or a browser verdict that no longer applies must not lock a moderator panel: once the
// moderator fixes what was refused, the next click posts. A reason of only spaces passes the
// browser's `required` but the server refuses it (reason.required), in place with scripts on or
// at the refusal address the server renders; a missing end date stops stale once the length changes.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

const reason = (scope: Locator) => scope.getByRole('textbox', { name: 'Reason' });

/** Spaces only, refused by the server in place: the reason box says why and is marked invalid. */
async function refuseSpaces(scope: Locator, submit: string, sent: URLSearchParams[]) {
  await reason(scope).fill('   ');
  await scope.getByRole('button', { name: submit, exact: true }).click();
  await expect(scope.getByText('Give a reason.')).toBeVisible();
  await expect(reason(scope)).toHaveAttribute('aria-invalid', 'true');
  expect(sent).toHaveLength(1);
}

async function moderator(page: Page) {
  await signedIn(page, world, world.moderator.name);
  return postsTo(page, '/modlog/act');
}

test('after a refused blank reason, a corrected one removes the comment on the next click', async ({ page }) => {
  const sent = await moderator(page);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  const comment = page.locator(`#comment-${world.comments.spam}`);
  await comment.getByRole('button', { name: 'Remove comment', exact: true }).click();
  await refuseSpaces(comment, 'Remove', sent);
  await reason(comment).fill('Spam, affiliate links');
  await expect(reason(comment)).not.toHaveAttribute('aria-invalid', 'true');
  await expect(comment.getByText('Give a reason.')).toHaveCount(0);
  await comment.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(comment.getByRole('button', { name: 'Restore comment', exact: true })).toBeVisible();
  expect(sent).toHaveLength(2);
});

test('after a refused blank ban reason, a corrected one bans on the next click', async ({ page }) => {
  const sent = await moderator(page);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  const panel = page.locator(`#comment-${world.comments.spam}`).getByTestId('mod-panel-ban');
  await panel.getByRole('button', { name: /^Ban from !/ }).click();
  await refuseSpaces(panel, 'Ban', sent);
  await reason(panel).fill('Rule 1: spam');
  await panel.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(panel.locator('form')).toBeHidden();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.get('reason')).toBe('Rule 1: spam');
});

test('at a refusal address the server rendered, a corrected reason removes the post on the next click', async ({ page }) => {
  const sent = await moderator(page);
  const id = world.posts.spam;
  await gotoHydrated(page, `/post/${id}?${new URLSearchParams({ modFor: `content:${id}`, modError: 'reason.required' })}`);
  const panel = page.locator(`#mod-content-${id}`);
  await expect(panel.getByText('Give a reason.')).toBeVisible();
  await expect(reason(panel)).toHaveAttribute('aria-invalid', 'true');
  await reason(panel).fill('Spam post');
  await expect(reason(panel)).not.toHaveAttribute('aria-invalid', 'true');
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore post', exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('a missing end date stops counting once the length is a fixed one, and the next click bans', async ({ page }) => {
  const sent = await moderator(page);
  await gotoHydrated(page, `/post/${world.posts.author}`);
  const panel = page.getByTestId('post-moderate').getByTestId('mod-panel-ban');
  await panel.getByRole('button', { name: /^Ban from !/ }).click();
  await reason(panel).fill('Rule 2: flooding');
  await panel.getByLabel('Length').selectOption('custom');
  await panel.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(panel.getByText('Fill in this field.')).toBeVisible();
  expect(sent).toHaveLength(0);
  await panel.getByLabel('Length').selectOption('30');
  await expect(panel.getByText('Fill in this field.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(panel.locator('form')).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('duration')).toBe('30');
});
