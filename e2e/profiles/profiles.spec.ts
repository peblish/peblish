import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { signInAdmin } from '../admin/support.ts';
import { expectAccessible, landed, signIn, type Admin } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane E1 end to end, on the built server and the lane database: a profile in each state (local,
// remote, bot, deleted, signed out, member, own, blocked, unknown, opted out of search), its
// tabs and sorts, the Block slot with and without JavaScript, and the Edit profile page.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  suffix: string;
  password: string;
  viewers: string[];
  owner: { name: string };
  community: { name: string };
  remote: { name: string; handle: string };
  remoteHost: string;
  bot: { handle: string };
  gone: { name: string };
  private: { name: string };
  posts: { owner: string[] };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-e1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

async function sameSession(browser: Browser, page: Page, options: { javaScriptEnabled?: boolean; locale?: string } = {}) {
  const context = await browser.newContext({ storageState: await page.context().storageState(), ...options });
  return context.newPage();
}

const profile = (name: string) => `/u/${name}`;

test.describe('anyone', () => {
  test('a local profile: card, tabs, posts and comments, and no axe violations', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, profile(seed.owner.name));
    const card = page.getByRole('complementary', { name: 'Profile' });
    await expect(card.getByRole('heading', { level: 1, name: 'Pat Profile' })).toBeVisible();
    await expect(card).toContainText(seed.owner.name);
    await expect(card.locator('strong, b')).toContainText('write');
    await expect(card.getByText('Joined')).toBeVisible();
    // Signed out: no actions at all.
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Edit profile' })).toHaveCount(0);

    const tabs = page.getByRole('navigation', { name: 'Activity' });
    await expect(tabs.getByRole('link', { name: /^Overview/ })).toHaveAttribute('aria-current', 'page');
    // The Overview lists comments and posts together.
    const list = page.getByRole('list', { name: 'Posts and comments' });
    await expect(list).toContainText(seed.posts.owner[0]!);
    await expect(list).toContainText('Owner comment 0');
    await expect(list.getByText('Owner adult post')).toHaveCount(0);
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);

    await tabs.getByRole('link', { name: /^Posts/ }).click();
    await expect(page).toHaveURL(/tab=posts/);
    for (const title of seed.posts.owner) await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText('Owner comment 0')).toHaveCount(0);

    await gotoHydrated(page, `${profile(seed.owner.name)}?tab=comments`);
    await expect(page.getByRole('list', { name: 'Posts and comments' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('link', { name: 'reply' }).first()).toHaveAttribute('href', /\/post\/.+\/comments\/.+/);
  });

  test('the Top sort is a link and a bad cursor starts again at the first page', async ({ page }) => {
    await gotoHydrated(page, `${profile(seed.owner.name)}?tab=posts`);
    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Top' }).click();
    await expect(page).toHaveURL(/sort=top/);
    await expect(page.getByText(seed.posts.owner[0]!)).toBeVisible();
    await gotoHydrated(page, `${profile(seed.owner.name)}?tab=posts&after=garbage&sort=nonsense`);
    await expect(page.getByText(seed.posts.owner[0]!)).toBeVisible();
  });

  test('works without JavaScript', async ({ browser }) => {
    const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    await plain.goto(`${profile(seed.owner.name)}?tab=posts`);
    await expect(plain.getByRole('heading', { level: 1, name: 'Pat Profile' })).toBeVisible();
    await expect(plain.getByText(seed.posts.owner[1]!)).toBeVisible();
    await plain.context().close();
  });

  test('a remote person shows their home and when the copy was refreshed', async ({ page }) => {
    await gotoHydrated(page, profile(seed.remote.handle));
    const card = page.getByRole('complementary', { name: 'Profile' });
    await expect(card.getByRole('heading', { level: 1, name: 'Remote Rita' })).toBeVisible();
    await expect(card).toContainText('Hello from elsewhere');
    await expect(card).toContainText(`${seed.remoteHost}, copy refreshed 3h`);
    await expectAccessible(page);
  });

  test('a remote display name with directional controls is isolated and cannot reorder the card', async ({ page }) => {
    const bidi = JSON.parse(
      execFileSync('node', ['e2e/profiles/bidi-seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
    ) as { handle: string; name: string };
    await gotoHydrated(page, profile(bidi.handle));
    const heading = page.getByRole('complementary', { name: 'Profile' }).getByRole('heading', { level: 1 });
    // The override (U+202E) and the isolate (U+2066) are dropped and the name sits in its own <bdi>.
    await expect(heading).toHaveText('Ada evil Admin');
    await expect(heading.locator('bdi')).toHaveText('Ada evil Admin');
    expect(bidi.name).toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });

  test('a bot account carries the Bot badge', async ({ page }) => {
    await gotoHydrated(page, profile(seed.bot.handle));
    await expect(page.getByRole('complementary', { name: 'Profile' }).getByText('Bot', { exact: true })).toBeVisible();
  });

  test('a deleted account says so and has no tabs', async ({ page }) => {
    await gotoHydrated(page, profile(seed.gone.name));
    await expect(page.getByText('This account was deleted.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Activity' })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  });

  test('a person who opted out of search is noindex; an ordinary one is not', async ({ page }) => {
    await gotoHydrated(page, profile(seed.private.name));
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await gotoHydrated(page, profile(seed.owner.name));
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });

  test('an unknown handle and a community are not profiles', async ({ page }) => {
    // /u/<name> negotiates by Accept; the HTML that falls through federation keeps the router's 404.
    for (const handle of ['nobody_here_zz', seed.community.name, 'nobody@unknown.test']) {
      const response = await page.goto(profile(handle), { waitUntil: 'commit' });
      expect(response?.status(), handle).toBe(404);
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' }), handle).toBeVisible();
    }
  });
});

test.describe('signed in', () => {
  test('a member blocks a person from their profile and unblocks from the notice', async ({ page }) => {
    await signedIn(page, seed.viewers[0]!);
    await gotoHydrated(page, profile(seed.owner.name));
    const card = page.getByRole('complementary', { name: 'Profile' });
    await expect(card.getByRole('link', { name: 'Edit profile' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Block' }).click();
    await expect(page.getByText('You blocked this person.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Activity' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Block' })).toHaveCount(0);

    // Reloaded, the notice stays and no activity is read.
    await gotoHydrated(page, profile(seed.owner.name));
    await expect(page.getByText(seed.posts.owner[0]!)).toHaveCount(0);
    await page.getByRole('button', { name: 'Unblock' }).click();
    await expect(page.getByRole('navigation', { name: 'Activity' })).toBeVisible();
    await expect(page.getByText(seed.posts.owner[0]!)).toBeVisible();
    await expectAccessible(page);
    // A member's comment rows carry the action slots (the Block form among them): they hydrate cleanly.
    const log = recordConsole(page);
    await gotoHydrated(page, `${profile(seed.owner.name)}?tab=comments`);
    await expect(
      page.getByRole('list', { name: 'Posts and comments' }).getByRole('listitem').getByRole('button', { name: 'Block' }).first(),
    ).toBeVisible();
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('the Block slot works without JavaScript too', async ({ page, browser }) => {
    await signedIn(page, seed.viewers[1]!);
    const plain = await sameSession(browser, page, { javaScriptEnabled: false });
    await plain.goto(profile(seed.owner.name));
    await plain.getByRole('complementary', { name: 'Profile' }).getByRole('button', { name: 'Block' }).click();
    await expect(plain).toHaveURL(new RegExp(`${profile(seed.owner.name)}$`));
    await expect(plain.getByText('You blocked this person.')).toBeVisible();
    await plain.getByRole('button', { name: 'Unblock' }).click();
    await expect(plain.getByText(seed.posts.owner[0]!)).toBeVisible();
    await plain.context().close();
  });

  test('blocking a whole instance shows the instance notice', async ({ page }) => {
    await signedIn(page, seed.viewers[2]!);
    await gotoHydrated(page, '/settings/blocks?tab=instances');
    await page.getByLabel('Block an instance by host').fill(seed.remoteHost);
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(page.getByRole('status')).toBeVisible();
    await gotoHydrated(page, profile(seed.remote.handle));
    await expect(page.getByText(`You blocked ${seed.remoteHost}`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage blocked instances' })).toBeVisible();
  });

  test("one's own profile offers Edit profile and Settings, no Block", async ({ page }) => {
    await signedIn(page, seed.owner.name);
    await gotoHydrated(page, profile(seed.owner.name));
    const card = page.getByRole('complementary', { name: 'Profile' });
    await expect(card.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', `${profile(seed.owner.name)}/edit`);
    await expect(card.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Block' })).toHaveCount(0);
    await expect(card.getByText('You', { exact: true })).toBeVisible();
  });

  test('Edit profile saves the name and the bio, shows the preview, and limits the lengths', async ({ page, browser }) => {
    const log = recordConsole(page);
    await signedIn(page, seed.owner.name);
    await gotoHydrated(page, `${profile(seed.owner.name)}/edit`);
    await expect(page.getByRole('heading', { level: 2, name: 'Edit profile' })).toBeVisible();
    await expectAccessible(page);
    const name = page.getByLabel('Display name');
    await expect(name).toHaveValue('Pat Profile');
    await name.fill('Pat Q. Profile');
    const bio = page.getByRole('textbox', { name: 'Bio' });
    await bio.fill('A **bold** bio');
    await page.getByRole('radio', { name: 'Preview' }).click();
    await expect(page.locator('.pb-prose strong', { hasText: 'bold' })).toBeVisible();
    await page.getByRole('radio', { name: 'Write' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved.');
    // The card on the left shows the new name once the data reloads.
    await expect(page.getByRole('complementary', { name: 'Profile' }).getByRole('heading', { level: 1 })).toHaveText('Pat Q. Profile');
    expect(log.hydrationProblems()).toEqual([]);

    // Over the limit: the counter turns, and Save is off.
    await name.fill('x'.repeat(101));
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await name.fill('Pat Profile');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();

    // Without scripts the form posts natively and comes back with the status in the address.
    const plain = await sameSession(browser, page, { javaScriptEnabled: false });
    await plain.goto(`${profile(seed.owner.name)}/edit`);
    await plain.getByLabel('Display name').fill('Pat Profile');
    await plain.getByRole('textbox', { name: 'Bio' }).fill('I **write** about boats.');
    await plain.getByRole('button', { name: 'Save changes' }).click();
    await expect(plain).toHaveURL(/edit\?saved=true/);
    await expect(plain.getByRole('status')).toContainText('Profile saved.');
    await plain.goto(profile(seed.owner.name));
    await expect(plain.getByRole('heading', { level: 1, name: 'Pat Profile' })).toBeVisible();
    await plain.context().close();
  });

  test("someone else's edit page goes to their profile; signed out goes to sign in", async ({ page, browser }) => {
    await signedIn(page, seed.viewers[3]!);
    await page.goto(`${profile(seed.owner.name)}/edit`);
    await expect(page).toHaveURL(new RegExp(`${profile(seed.owner.name)}$`));
    const anonymous = await browser.newPage();
    await anonymous.goto(`${profile(seed.owner.name)}/edit`);
    await expect(anonymous).toHaveURL(/\/auth\/sign-in/);
    await anonymous.close();
  });

  test('in German, the profile and the edit page have no axe violations', async ({ page, browser }) => {
    await signedIn(page, seed.owner.name);
    const german = await sameSession(browser, page, { locale: 'de-DE' });
    await gotoHydrated(german, profile(seed.owner.name));
    await expect(german.getByRole('navigation', { name: 'Aktivität' })).toBeVisible();
    await expectAccessible(german);
    await gotoHydrated(german, `${profile(seed.owner.name)}/edit`);
    await expect(german.getByRole('heading', { level: 2, name: 'Profil bearbeiten' })).toBeVisible();
    await expectAccessible(german);
    await german.context().close();
  });
});

// The review cases (lane e2, after the Mux restyle), on their own cast (e2e/profiles/seed.ts).
type Review = {
  suffix: string;
  password: string;
  long: { handle: string; name: string; host: string; displayName: string };
  prolific: { name: string; posts: string[] };
  visitor: { name: string };
  moderator: { name: string };
  admin: Admin;
  community: { name: string };
};

let review: Review;
const reviewSeed = () => {
  review ??= JSON.parse(
    execFileSync('node', ['e2e/profiles/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as Review;
  return review;
};

/**
 * Nothing in `box` is cut off: no element that hides overflow holds wider content, every handle
 * (its host included) and heading lies inside the box, and the page does not scroll sideways.
 */
async function expectUnclipped(box: Locator) {
  const problems = await box.evaluate((root) => {
    const out: string[] = [];
    const page = document.documentElement;
    if (page.scrollWidth > page.clientWidth) out.push(`the page scrolls sideways (${page.scrollWidth} > ${page.clientWidth})`);
    const edge = root.getBoundingClientRect();
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      // A visually hidden text (1px, clipped) is meant to hide.
      const hides = ['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(element).overflowX) && element.clientWidth > 1;
      if (hides && element.scrollWidth > element.clientWidth + 1)
        out.push(`${element.className || element.tagName} hides ${element.scrollWidth - element.clientWidth}px`);
    }
    for (const element of root.querySelectorAll('.pb-handle, .pb-handle__host, h1, dd'))
      for (const rect of element.getClientRects())
        if (rect.left < edge.left - 0.5 || rect.right > edge.right + 0.5)
          out.push(`${element.className || element.tagName} "${element.textContent}" runs past the box`);
    return out;
  });
  expect(problems).toEqual([]);
}

test.describe('review cases', () => {
  test.beforeAll(() => {
    reviewSeed();
  });

  for (const width of [320, 400]) {
    test(`at ${width} px a long name, handle and host wrap inside the card`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await gotoHydrated(page, profile(review.long.handle));
      const card = page.getByRole('complementary', { name: 'Profile' });
      await expect(card.getByRole('heading', { level: 1, name: review.long.displayName })).toBeVisible();
      await expect(card).toContainText(`@${review.long.handle}`);
      await expect(card.locator('.pb-handle__host')).toHaveText(`@${review.long.host}`);
      await expect(card.getByText(new RegExp(`^${review.long.host.replaceAll('.', '\\.')}, copy refreshed`))).toBeVisible();
      await expectUnclipped(card);
    });
  }

  test('a person with no activity shows the empty state on every tab, with no page links', async ({ page }) => {
    for (const [tab, text] of [
      ['', 'No activity yet.'],
      ['?tab=posts', 'No posts yet.'],
      ['?tab=comments', 'No comments yet.'],
    ] as const) {
      await gotoHydrated(page, `${profile(review.long.handle)}${tab}`);
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Posts and comments' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /^(Next|First) page$/ })).toHaveCount(0);
    }
  });

  test('the page links keep the tab and the sort', async ({ page }) => {
    const items = () => page.getByRole('list', { name: 'Posts and comments' }).locator(':scope > li');
    await gotoHydrated(page, `${profile(review.prolific.name)}?tab=posts&sort=top`);
    await expect(items()).toHaveCount(20);
    await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\?tab=posts&sort=top&after=[^&]+$/);
    await expect(items()).toHaveCount(3);
    await expect(page.getByRole('navigation', { name: 'Activity' }).getByRole('link', { name: /^Posts/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Top' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await page.getByRole('link', { name: 'First page' }).click();
    await expect(page).toHaveURL(new RegExp(`${profile(review.prolific.name)}\\?tab=posts&sort=top$`));
    await expect(items()).toHaveCount(20);
  });

  test('the edit form marks a display name and a bio past their limits, says why, and Save waits for both', async ({ page, browser }) => {
    await signedIn(page, review.prolific.name);
    await gotoHydrated(page, `${profile(review.prolific.name)}/edit`);
    const name = page.getByLabel('Display name');
    const bio = page.getByRole('textbox', { name: 'Bio' });
    const save = page.getByRole('button', { name: 'Save changes' });
    const counter = (text: string) => page.locator('.prof-count', { hasText: text });

    await name.fill('x'.repeat(100));
    await expect(counter('100 / 100')).not.toHaveAttribute('data-over');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeEnabled();
    await name.fill('x'.repeat(101));
    await expect(counter('101 / 100')).toHaveAttribute('data-over');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();
    // The field says why, under itself and in its description; Enter does not post it.
    const nameMessage = 'Display names are at most 100 characters.';
    await expect(page.getByText(nameMessage)).toBeVisible();
    await expect(name).toHaveAccessibleDescription(new RegExp(nameMessage.replace('.', '\\.')));
    await name.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${profile(review.prolific.name)}/edit$`));
    await expect(page.getByText(nameMessage)).toBeVisible();

    await bio.fill('y'.repeat(2_001));
    await expect(counter('2,001 / 2,000')).toHaveAttribute('data-over');
    await expect(bio).toHaveAttribute('aria-invalid', 'true');
    await expect(bio).toHaveAccessibleDescription(/The bio is at most 2,000 characters\./);
    // Both over: bringing the name back is not enough.
    await name.fill('Prolific');
    await expect(page.getByText(nameMessage)).toHaveCount(0);
    await expect(counter('8 / 100')).not.toHaveAttribute('data-over');
    await expect(save).toBeDisabled();
    await bio.fill('y'.repeat(2_000));
    await expect(counter('2,000 / 2,000')).not.toHaveAttribute('data-over');
    await expect(bio).not.toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeEnabled();
    // Past the limit the counter takes the danger token.
    await bio.fill('y'.repeat(2_001));
    const colours = await counter('2,001 / 2,000').evaluate((over) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--muxui-semantic-feedback-invalid)';
      over.parentElement!.append(probe);
      const wanted = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(over).color, wanted];
    });
    expect(colours[0]).toBe(colours[1]);

    // The messages follow the page's language.
    const german = await sameSession(browser, page, { locale: 'de-DE' });
    await gotoHydrated(german, `${profile(review.prolific.name)}/edit`);
    await german.getByLabel('Anzeigename').fill('x'.repeat(101));
    await expect(german.getByText('Der Anzeigename darf höchstens 100 Zeichen lang sein.')).toBeVisible();
    await german.getByRole('textbox', { name: 'Über mich' }).fill('y'.repeat(2_001));
    await expect(german.getByText('Die Beschreibung darf höchstens 2.000 Zeichen lang sein.')).toBeVisible();
    await german.context().close();
  });

  test('a moderator sees the community ban, an admin the instance ban, and a visitor neither', async ({ page, browser }) => {
    const moderateOf = (on: Page) => on.getByRole('complementary', { name: 'Profile' }).getByTestId('profile-moderate');

    await signedIn(page, review.visitor.name);
    await gotoHydrated(page, profile(review.prolific.name));
    await expect(page.getByRole('complementary', { name: 'Profile' }).getByRole('button', { name: 'Block' })).toBeVisible();
    await expect(moderateOf(page)).toHaveCount(0);

    const moderator = await (await browser.newContext()).newPage();
    await signedIn(moderator, review.moderator.name);
    await gotoHydrated(moderator, profile(review.prolific.name));
    await expect(moderateOf(moderator).getByText(`Ban from !${review.community.name}`, { exact: true })).toBeVisible();
    await expect(moderateOf(moderator).getByText('Ban from this instance', { exact: true })).toHaveCount(0);
    await moderator.context().close();

    const admin = await (await browser.newContext()).newPage();
    await signInAdmin(admin, review.admin);
    await gotoHydrated(admin, profile(review.prolific.name));
    await expect(moderateOf(admin).getByText('Ban from this instance', { exact: true })).toBeVisible();
    await expect(moderateOf(admin).getByText(/^Ban from !/)).toHaveCount(0);
    await admin.context().close();
  });
});
