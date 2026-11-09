import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectAccessible, freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane COMM end to end, on the built server and the lane database: the NSFW gate (signed out,
// undeclared, under 16, Hide NSFW on, Show once and Show always), the community page for each
// viewer and state, and the community form. The seed (testing/seed-comm.ts) holds a secret string
// in everything a flagged community must not leak. The steps share seeded data, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Community = { id: string; handle: string };
type Seed = {
  password: string;
  suffix: string;
  secret: string;
  admin: { name: string; totpSecret: string };
  people: { moderator: string; member: string; declared: string; undeclared: string; young: string; banned: string };
  communities: {
    open: Community;
    restricted: Community;
    empty: Community;
    quiet: Community;
    nsfw: Community;
    nsfwOther: Community;
    remote: Community & { host: string };
  };
  posts: { plain: string; flaggedInOpen: string; inNsfw: string; inNsfwOther: string; remote: string };
};

const root = join(import.meta.dirname, '../..');
let seed: Seed;
test.beforeAll(() => {
  seed = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-comm.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;
});

const community = (handle: string) => `/c/${handle}`;

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

async function signedInAdmin(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.admin.name}`, seed.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(seed.admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

let adminState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

/** A page signed in as the admin. Signing in spends a two-factor code and a 30 second step, so it happens once and every test borrows the session. */
async function adminPage(browser: Browser, options: { locale?: string; javaScriptEnabled?: boolean } = {}) {
  if (!adminState) {
    const context = await browser.newContext({ locale: 'en-US' });
    await signedInAdmin(await context.newPage());
    adminState = await context.storageState();
    await context.close();
  }
  return (await browser.newContext({ storageState: adminState, ...options })).newPage();
}

/** The server-rendered HTML a page (and its session) receives, before any script runs. */
async function html(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return { status: response.status(), text: await response.text(), headers: response.headers() };
}

/** A fresh browser context that keeps the persistent cookies of `page`'s and loses the session ones: a browser that was closed and reopened. */
async function restarted(page: Page, browser: Browser) {
  const state = await page.context().storageState();
  const context = await browser.newContext({ storageState: { ...state, cookies: state.cookies.filter(({ expires }) => expires !== -1) } });
  return context.newPage();
}

const declaredRow = (name: string) =>
  (
    JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-comm.ts', 'declared', name], { cwd: root, encoding: 'utf8' })) as {
      declared: boolean;
    }
  ).declared;

async function declare(page: Page, day: string, month: string, year: string) {
  await page.getByLabel('Day').fill(day);
  await page.getByLabel('Month').selectOption(month);
  await page.getByLabel('Year').fill(year);
  await page.getByRole('button', { name: 'Declare and continue' }).click();
}

test.describe('the NSFW gate', () => {
  test('a signed-out viewer of a flagged community gets a 200 gate with nothing of the community, noindex and no-store', async ({
    page,
  }) => {
    const { handle } = seed.communities.nsfw;
    const { status, text, headers } = await html(page, community(handle));
    expect(status).toBe(200);
    expect(text).not.toContain(seed.secret);
    expect(text).toContain('This community is NSFW');
    expect(text).toContain(`/auth/sign-in?redirect=${encodeURIComponent(community(handle))}`);
    expect(text).toContain('name="robots" content="noindex"');
    expect(headers['x-robots-tag']).toBe('noindex');
    expect(headers['cache-control']).toBe('private, no-store');
    await gotoHydrated(page, community(handle));
    await expect(page.locator('#pb-main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up with an invite' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(seed.secret);
    await expectAccessible(page);
    // The post in it is gated the same way, and the permalink with it.
    const post = await html(page, `/post/${seed.posts.inNsfw}`);
    expect([post.status, post.text.includes(seed.secret), post.text.includes('This post is NSFW')]).toEqual([200, false, true]);
  });

  test('a viewer under 16 saves nothing, is blocked for 24 hours and sees no form on a retry', async ({ page, context }) => {
    await signedIn(page, seed.people.young);
    await gotoHydrated(page, community(seed.communities.nsfw.handle));
    await expect(page.getByRole('heading', { name: 'Declare that you are 16 or older' })).toBeVisible();
    await declare(page, '1', '1', String(new Date().getUTCFullYear() - 10));
    await expect(page.getByRole('heading', { name: "You can't view NSFW content" })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(seed.secret);
    expect(declaredRow(seed.people.young)).toBe(false);
    const cookie = (await context.cookies()).find(({ name }) => name === 'peblish.age_gate');
    expect(cookie?.httpOnly).toBe(true);
    await gotoHydrated(page, community(seed.communities.nsfw.handle));
    await expect(page.getByLabel('Day')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: "You can't view NSFW content" })).toBeVisible();
    await expectAccessible(page);
  });

  test('declaring 16 or older, a viewer lands on Hide NSFW is on; a false date is refused in place', async ({ page }) => {
    await signedIn(page, seed.people.undeclared);
    await gotoHydrated(page, community(seed.communities.nsfw.handle));
    await declare(page, '31', '2', '1990');
    await expect(page.getByRole('alert')).toHaveText('Enter a real date of birth.');
    expect(declaredRow(seed.people.undeclared)).toBe(false);
    await declare(page, '15', '6', '1990');
    await expect(page.getByRole('heading', { name: 'Hide NSFW is on' })).toBeVisible();
    await expect(page).toHaveURL(community(seed.communities.nsfw.handle));
    expect(declaredRow(seed.people.undeclared)).toBe(true);
    expect(await html(page, community(seed.communities.nsfw.handle))).toMatchObject({ status: 200 });
  });

  test('Hide NSFW is on by default; Show once opens one community and its posts until the browser closes', async ({ page, browser }) => {
    await signedIn(page, seed.people.declared);
    const { nsfw, nsfwOther } = seed.communities;
    const gated = await html(page, community(nsfw.handle));
    expect(gated.text).not.toContain(seed.secret);
    expect(gated.text).toContain('Hide NSFW is on');
    await gotoHydrated(page, community(nsfw.handle));
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Show once' }).click();
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { name: `${seed.secret} name` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide NSFW' })).toBeVisible();
    // A flagged post in that community opens; another flagged community and its post stay hidden.
    expect((await html(page, `/post/${seed.posts.inNsfw}`)).text).toContain(`${seed.secret} nsfw post`);
    expect((await html(page, community(nsfwOther.handle))).text).not.toContain(seed.secret);
    expect((await html(page, `/post/${seed.posts.inNsfwOther}`)).text).not.toContain(seed.secret);
    // A flagged post in a plain community needs that community's own Show once.
    expect((await html(page, `/post/${seed.posts.flaggedInOpen}`)).text).not.toContain(seed.secret);
    // Show once lasts until the browser closes.
    const reopened = await restarted(page, browser);
    expect((await html(reopened, community(nsfw.handle))).text).not.toContain(seed.secret);
    await reopened.context().close();
    // Hide NSFW closes it again.
    await page.goto(community(nsfw.handle));
    await page.getByRole('button', { name: 'Hide NSFW' }).click();
    await expect(page.getByRole('heading', { name: 'Hide NSFW is on' })).toBeVisible();
  });

  test('Show always survives a closed browser; Hide NSFW reverses it', async ({ page, browser }) => {
    await signedIn(page, seed.people.declared);
    const { nsfw, nsfwOther } = seed.communities;
    await gotoHydrated(page, community(nsfw.handle));
    await page.getByRole('button', { name: 'Show always' }).click();
    await expect(page.getByRole('heading', { name: `${seed.secret} name` })).toBeVisible();
    const reopened = await restarted(page, browser);
    expect((await html(reopened, community(nsfwOther.handle))).text).toContain(`${seed.secret} other`);
    expect((await html(reopened, `/post/${seed.posts.flaggedInOpen}`)).text).toContain(`${seed.secret} flagged post`);
    await reopened.getByRole('button', { name: 'Hide NSFW' }).click();
    await expect(reopened.getByRole('heading', { name: 'Hide NSFW is on' })).toBeVisible();
    await reopened.context().close();
  });
});

test.describe('the community page', () => {
  test('a local community for a member: header, counts held here, feed, sidebar, rules and hydration', async ({ page }) => {
    const log = recordConsole(page);
    await signedIn(page, seed.people.member);
    const { handle } = seed.communities.open;
    const response = await page.goto(community(handle), { waitUntil: 'commit' });
    expect(response?.headers()['cache-control']).toBe('private, no-store');
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Open ${seed.suffix}`);
    await expect(page.locator('.cm-stats')).toContainText('3 posts');
    await expect(page.locator('.cm-stats')).toContainText('subscribers');
    await expect(page.getByRole('link', { name: `Plain post ${seed.suffix}` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'About' }).or(page.locator('#about'))).toContainText('A friendly place');
    await expect(page.locator('.cm-rules > li')).toContainText(['Be civil', 'Stay on topic']);
    await expect(page.locator('.cm-mods')).toContainText('local');
    await expect(page.getByRole('link', { name: 'Modlog for this community' })).toHaveAttribute('href', /\/modlog\?community=/);
    await page.waitForLoadState('networkidle');
    expect(log.hydrationProblems()).toEqual([]);
    await expectAccessible(page);
  });

  test('Join, Joined and leaving, hydrated and without JavaScript', async ({ page, browser }) => {
    await signedIn(page, seed.people.member);
    const { handle } = seed.communities.empty;
    await gotoHydrated(page, community(handle));
    await expect(page.getByRole('heading', { name: 'No posts yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Be the first to post' })).toHaveAttribute('href', `/submit?community=${handle}`);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Joined' })).toBeVisible();
    await expect(page.locator('.cm-stats')).toContainText('1 subscriber');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Joined' })).toBeVisible();
    await page.getByRole('button', { name: 'Joined' }).click();
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();

    // Without JavaScript: a plain form post and a 303 back.
    const plain = await (
      await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() })
    ).newPage();
    await plain.goto(community(handle));
    await plain.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(plain.getByRole('button', { name: 'Joined' })).toBeVisible();
    await plain.getByRole('button', { name: 'Joined' }).click();
    await expect(plain.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
    await plain.context().close();
  });

  test('signed out, Join goes to sign-in and back; a banned viewer is told so', async ({ page }) => {
    const { handle } = seed.communities.open;
    await gotoHydrated(page, community(handle));
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForURL(`**/auth/sign-in?redirect=${encodeURIComponent(community(handle))}`);
    await signedIn(page, seed.people.banned);
    await gotoHydrated(page, community(handle));
    await expect(page.locator('.cm-head')).toContainText('You are banned from this community.');
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);
  });

  test('a remote community: the strip, every moderator state and Pending, which a click cancels', async ({ page }) => {
    // Axe reads colours mid-transition otherwise, as the Join button changes state.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page, seed.people.member);
    const { remote } = seed.communities;
    await gotoHydrated(page, community(remote.handle));
    await expect(page.locator('.cm-strip')).toContainText(`Home server: ${remote.host}`);
    await expect(page.locator('.cm-strip')).toContainText('Local copy last refreshed');
    await expect(page.locator('.cm-strip').getByRole('link', { name: `Open on ${remote.host}` })).toBeVisible();
    const mods = page.locator('.cm-mods li');
    await expect(mods).toHaveCount(3);
    await expect(mods.nth(0)).toContainText('fresh, synced');
    await expect(mods.nth(1)).toContainText('stale, last seen');
    await expect(mods.nth(2)).toContainText('unknown');
    await expect(page.locator('.cm-stats')).toContainText('held locally');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pending' })).toBeVisible();
    await page.getByRole('button', { name: 'Pending' }).click();
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
    await expectAccessible(page);
  });

  test('New post is disabled with a reason in a restricted community unless staff; Mod tools only for staff', async ({ page, browser }) => {
    const { restricted, open, remote } = seed.communities;
    await signedIn(page, seed.people.member);
    await gotoHydrated(page, community(restricted.handle));
    await expect(page.locator('.cm-disabled')).toHaveAttribute('title', 'Posting is restricted to moderators');
    await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);
    await expect(page.getByText('Mod tools')).toHaveCount(0);
    await page.context().clearCookies();
    await gotoHydrated(page, community(restricted.handle));
    await expect(page.getByText('Mod tools')).toHaveCount(0);

    const moderator = await (await browser.newContext()).newPage();
    await signedIn(moderator, seed.people.moderator);
    await gotoHydrated(moderator, community(restricted.handle));
    await expect(moderator.getByRole('link', { name: 'New post' })).toHaveAttribute('href', `/submit?community=${restricted.handle}`);
    await moderator.getByText('Mod tools').click();
    await expect(moderator.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', /\/admin\/reports\?community=/);
    await expect(moderator.getByRole('link', { name: 'Edit community' })).toHaveAttribute('href', `/c/${restricted.handle}/edit`);
    await gotoHydrated(moderator, community(remote.handle));
    // A moderator here holds no role in a remote community.
    await expect(moderator.getByText('Mod tools')).toHaveCount(0);
    await moderator.context().close();

    const admin = await adminPage(browser);
    await gotoHydrated(admin, community(remote.handle));
    await admin.getByText('Mod tools').click();
    await expect(admin.getByText('Local actions only on this copy')).toBeVisible();
    await expect(admin.getByRole('link', { name: 'Edit community' })).toHaveCount(0);
    await gotoHydrated(admin, community(open.handle));
    await expect(admin.getByText('Mod tools')).toBeVisible();
    await admin.context().close();
  });

  test('unknown, and noindex only when the community says so', async ({ page }) => {
    const missing = await html(page, '/c/nobody_here');
    expect(missing.status).toBe(404);
    const remote = await html(page, '/c/lab@nowhere.test');
    expect(remote.status).toBe(404);
    expect(remote.text).toContain('/resolve?q=');
    expect((await html(page, community(seed.communities.open.handle))).text).not.toContain('name="robots"');
    expect((await html(page, community(seed.communities.quiet.handle))).text).toContain('name="robots" content="noindex"');
  });
});

test.describe('the community form', () => {
  test('a member is refused in place with a 403, and signed out goes to sign-in', async ({ page, context }) => {
    await signedIn(page, seed.people.member);
    const refused = await html(page, '/c/new');
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('Only site admins can create communities.');
    const edit = await html(page, `/c/${seed.communities.restricted.handle}/edit`);
    expect(edit.status).toBe(403);
    expect(edit.text).toContain('Only the owners, the moderators and site admins can edit this community.');
    const remote = await html(page, `/c/${seed.communities.remote.handle}/edit`);
    expect([remote.status, remote.text.includes('This community lives on another server.')]).toEqual([403, true]);
    await context.clearCookies();
    await page.goto('/c/new');
    await page.waitForURL('**/auth/sign-in?redirect=%2Fc%2Fnew');
  });

  test('the admin creates a community: field problems show in place and keep what was typed, then a 303 to the page', async ({
    browser,
  }) => {
    const page = await adminPage(browser);
    // The directory offers the form to an admin.
    await gotoHydrated(page, '/communities');
    await page.getByRole('link', { name: 'New community' }).click();
    await page.waitForURL('**/c/new');
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New community');
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link')).toHaveText([
      'Basics',
      'Rules',
      'Icon and banner',
      'Content and posting',
      'Visibility',
    ]);
    await expect(page.getByText('uploads off')).toHaveCount(2);
    await expectAccessible(page);

    await page.getByLabel('Name', { exact: true }).fill('bad name');
    await page.getByLabel('Title').fill('A new place');
    await page.locator('textarea[name="description"]').fill('x'.repeat(10_001));
    await page.getByRole('button', { name: 'Create community' }).click();
    await expect(page.getByText('Some fields need a change.')).toBeVisible();
    await expect(page.getByText('The description is longer than 10,000 characters.')).toBeVisible();
    await expect(page.getByText('Use letters, numbers and underscores, 50 at most.')).toBeVisible();
    await expect(page.getByLabel('Title')).toHaveValue('A new place');

    const name = `made_${seed.suffix}`;
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.locator('textarea[name="description"]').fill('A **fresh** sidebar.');
    await page.getByRole('textbox', { name: 'Rule 1', exact: true }).fill('Be kind');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByRole('textbox', { name: 'Rule 2', exact: true }).fill('No spam');
    await page.getByRole('button', { name: 'Move rule 2 up' }).click();
    await expect(page.getByText('2 of 15.')).toBeVisible();
    await page.getByText('German', { exact: true }).click();
    await page.getByText('Posting restricted to moderators', { exact: true }).click();
    await page.getByRole('button', { name: 'Create community' }).click();
    await page.waitForURL(`**${community(name)}`);
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A new place');
    await expect(page.locator('.cm-rules > li')).toHaveText(['No spam', 'Be kind']);
    await expect(page.locator('.cm-side')).toContainText('fresh');
    await expect(page.locator('.cm-side')).toContainText('German');
    // A site admin posts in a restricted community; the header still says it is restricted.
    await expect(page.locator('.cm-address')).toContainText('Only moderators can post here');
  });

  test('a duplicate name without JavaScript comes back as ?error=name.taken and loses what was typed', async ({ browser }) => {
    const plain = await adminPage(browser, { javaScriptEnabled: false });
    await plain.goto('/c/new');
    await plain.getByLabel('Name', { exact: true }).fill(seed.communities.open.handle);
    await plain.getByLabel('Title').fill('Typed and lost');
    await plain.getByRole('button', { name: 'Create community' }).click();
    await plain.waitForURL('**/c/new?error=name.taken');
    await expect(plain.getByText('A person or a community already has this name.')).toBeVisible();
    await expect(plain.getByLabel('Title')).toHaveValue('');
    await plain.context().close();
  });

  test("a moderator's edit persists; the name is fixed and the modlog sentence is there", async ({ page }) => {
    const { restricted } = seed.communities;
    await signedIn(page, seed.people.moderator);
    await gotoHydrated(page, `/c/${restricted.handle}/edit`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edit community');
    await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
    await expect(page.getByText('cannot be changed')).toBeVisible();
    await expect(page.getByText('Edits are logged in the modlog with your handle and the fields you changed.')).toBeVisible();
    await expect(page.getByLabel('Title')).toHaveValue(`Notices ${seed.suffix}`);
    await expect(page.getByRole('checkbox', { name: 'Posting restricted to moderators' })).toBeChecked();
    await page.getByLabel('Title').fill('Renamed notices');
    await page.getByRole('textbox', { name: 'Rule 1', exact: true }).fill('Read first');
    await page.getByText('Posting restricted to moderators', { exact: true }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForURL(`**${community(restricted.handle)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed notices');
    await expect(page.getByRole('link', { name: 'New post' })).toBeVisible();
    await expect(page.locator('.cm-rules > li')).toHaveText(['Read first']);
    await gotoHydrated(page, `/c/${restricted.handle}/edit`);
    await expect(page.getByLabel('Title')).toHaveValue('Renamed notices');
    await expect(page.getByRole('checkbox', { name: 'Posting restricted to moderators' })).not.toBeChecked();
  });
});

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the community page speaks German and passes axe', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, community(seed.communities.open.handle));
    await expect(page.getByRole('button', { name: 'Beitreten' })).toBeVisible();
    await expect(page.locator('.cm-stats')).toContainText('Beiträge');
    await page.waitForLoadState('networkidle');
    expect(log.hydrationProblems()).toEqual([]);
    await expectAccessible(page);
  });

  test('the community form speaks German and passes axe', async ({ browser }) => {
    const page = await adminPage(browser, { locale: 'de-DE' });
    await gotoHydrated(page, '/c/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Neue Community');
    await expect(page.getByRole('button', { name: 'Community anlegen' })).toBeVisible();
    await expectAccessible(page);
  });

  test('the gate speaks German', async ({ page }) => {
    await gotoHydrated(page, community(seed.communities.nsfw.handle));
    await expect(page.getByRole('heading', { name: 'Diese Community ist NSFW' })).toBeVisible();
    await expectAccessible(page);
  });
});
