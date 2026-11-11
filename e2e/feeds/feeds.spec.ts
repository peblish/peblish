import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane C1 end to end, on the built server and the lane database: the five feeds hydrate and
// pass axe, the sorts and the density switch, the next page with and without JavaScript, the
// sensitive-content gate in the feed, and a remote picture never reaching the page as it is.
// The steps share seeded posts, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  viewer: { name: string };
  undeclared: { name: string };
  communities: { local: string; remote: string };
  posts: Record<string, string>;
};

/** Remote names as other servers send them (e2e/feeds/seed-names.ts). */
type Names = {
  long: { id: string; title: string; host: string; community: string; author: string };
  title: { id: string; domain: string };
  hostile: { id: string; title: string; host: string; author: string };
};

let seed: Seed;
let names: Names;
test.beforeAll(() => {
  const run = (script: string, ...args: string[]) =>
    execFileSync('node', [script, ...args], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
  seed = JSON.parse(run('packages/core/src/testing/seed-c1.ts', 'e2e')) as Seed;
  names = JSON.parse(run('e2e/feeds/seed-names.ts')) as Names;
});

/** Requests that cast a vote on the post `id` (castVoteFn is a POST to a server function). */
const isVoteOn = (id: string) => (request: Request) =>
  request.method() === 'POST' && request.url().includes('/_serverFn/') && (request.postData() ?? '').includes(id);

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/** The card titles on the page, in order. */
const titles = (page: Page) => page.locator('.feed-list .pb-post__title a').allTextContents();
/** The posts' addresses: titles repeat across runs on a lane database, so a page-overlap check compares these. */
const postLinks = (page: Page) =>
  page.locator('.feed-list .pb-post__title a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));

/** The server-rendered HTML of `path` for this page's session, before any script runs. */
async function html(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return response.text();
}

test.describe('anyone', () => {
  for (const path of ['/', '/all', '/local', '/popular', '/moderating']) {
    test(`${path} hydrates, names its feed and has no axe violations`, async ({ page }) => {
      const log = recordConsole(page);
      await gotoHydrated(page, path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        { '/': 'Local', '/all': 'All', '/local': 'Local', '/popular': 'Popular', '/moderating': 'Moderating' }[path]!,
      );
      await expect(page.getByRole('radiogroup', { name: 'View' })).toBeVisible();
      await expectAccessible(page);
      expect(log.hydrationProblems()).toEqual([]);
    });
  }

  test('a signed-out visitor to Moderating is asked to sign in', async ({ page }) => {
    await gotoHydrated(page, '/moderating');
    await expect(page.getByRole('heading', { name: 'Sign in to see your moderating feed' })).toBeVisible();
    await expect(page.locator('#pb-main').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/auth/sign-in?redirect=%2Fmoderating',
    );
  });

  test('the toolbar sorts by link: New, Old and Top with its period, and an unknown sort falls back', async ({ page }) => {
    await gotoHydrated(page, '/all');
    await expect(page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Hot' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Top' }).click();
    await page.waitForURL('**/all?sort=top');
    await expect(page.getByRole('navigation', { name: 'Top of' }).getByRole('link', { name: 'Day' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The period is a link too: the top of the week is the best scored post first.
    await page.getByRole('navigation', { name: 'Top of' }).getByRole('link', { name: 'Week' }).click();
    await page.waitForURL('**/all?sort=top&period=week');
    expect((await titles(page))[0]).toBe(`Picture ${seed.suffix}`);
    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'New' }).click();
    await page.waitForURL('**/all?sort=new');
    await expect(page.getByRole('navigation', { name: 'Top of' })).toHaveCount(0);
    await gotoHydrated(page, '/all?sort=bogus&period=nonsense');
    await expect(page).toHaveURL(/\/all$/);
    await expect(page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Hot' })).toHaveAttribute('aria-current', 'page');
  });

  test('the density switch changes the cards and the choice is kept', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    const first = page.locator('.feed-list article').first();
    await expect(first).toHaveAttribute('data-density', 'classic');
    await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Compact' }).click();
    await expect(first).toHaveAttribute('data-density', 'compact');
    await page.reload();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'compact');
    // A second selection persists as well, not only the first.
    await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Card' }).click();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'card');
    await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Classic' }).click();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'classic');
    await page.reload();
    await expect(page.locator('.feed-list article').first()).toHaveAttribute('data-density', 'classic');
    await expect(page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Classic' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('each post is named by its title, and so is its vote group', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    const title = `Picture ${seed.suffix}`;
    const card = page.getByRole('article', { name: title });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('group', { name: `Vote on ${title}`, exact: true })).toBeVisible();
    // Every vote group on the page has its own name.
    const groups = await page
      .locator('.feed-list article [role="group"]')
      .evaluateAll((all) => all.map((group) => group.getAttribute('aria-label')));
    expect(new Set(groups).size).toBe(groups.length);
  });

  test('a sensitive post is not in the signed-out HTML, and a remote picture is never sent as its own URL', async ({ page }) => {
    const text = await html(page, '/all?sort=top');
    expect(text).not.toContain(`Sensitive ${seed.suffix}`);
    expect(text).toContain(`Picture ${seed.suffix}`);
    // The card shows the link's domain as text, but the picture's URL (the thumbnail's and the image post's own link) is never in the page.
    expect(text).not.toContain(`images.example.test/${seed.suffix}.png`);
    expect(text).not.toMatch(/<img[^>]*images\.example\.test/);
    // Cutting the address to its host keeps what the card draws from it: the image mark and the domain.
    const card = page.locator('.feed-list article', { hasText: `Picture ${seed.suffix}` });
    await expect(card).toHaveAttribute('data-kind', 'image');
    await expect(card.locator('.pb-post__domain')).toHaveText('(images.example.test)');
  });

  /**
   * Every line box of the post's handles and domain, with the box of the element that would clip
   * it: the nearest ancestor that hides overflow, or the post's frame when none does.
   */
  const identityLayout = (card: ReturnType<Page['locator']>) =>
    card.evaluate((article) => {
      const frame = article.querySelector('.pb-post__frame')!;
      const clipOf = (element: Element) => {
        for (let node = element.parentElement; node && node !== article; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return node;
        }
        return frame;
      };
      const pieces = [...article.querySelectorAll('.pb-handle__name, .pb-handle__host, .pb-post__domain')];
      const outside = pieces.flatMap((piece) => {
        const range = document.createRange();
        range.selectNodeContents(piece);
        const clip = clipOf(piece).getBoundingClientRect();
        return [...range.getClientRects()]
          .filter((line) => line.width > 0)
          .filter(
            (line) =>
              line.left < clip.left - 0.5 || line.right > clip.right + 0.5 || line.top < clip.top - 0.5 || line.bottom > clip.bottom + 0.5,
          )
          .map(() => `${piece.className}: ${piece.textContent}`);
      });
      return {
        pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        cardOverflows: article.scrollWidth > article.clientWidth,
        outside,
      };
    });

  test('a long remote community, author and host show in full inside the card, in every density, at 320px and 1280px', async ({
    page,
    context,
    baseURL,
  }) => {
    const { long } = names;
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const density of ['card', 'classic', 'compact']) {
        await context.addCookies([{ name: 'peblish_prefs', value: `density=${density}&scheme=system`, url: baseURL! }]);
        await gotoHydrated(page, '/all?sort=new');
        const card = page.locator('.feed-list article', { has: page.locator(`a[href="/post/${long.id}"]`) }).first();
        await expect(card).toHaveAttribute('data-density', density);
        const label = `${density} at ${width}px`;
        // The whole identity is there and drawn: prefix, name and host, with the host separate.
        const community = card.locator('.pb-post__community .pb-handle');
        await expect(community, label).toHaveText(`!${long.community}@${long.host}`);
        await expect(community.locator('.pb-handle__host'), label).toBeVisible();
        const author = card.locator('.pb-post__by .pb-handle');
        await expect(author, label).toHaveText(`@${long.author}@${long.host}`);
        await expect(author.locator('.pb-handle__host'), label).toBeVisible();
        await expect(card.locator('.pb-post__domain'), label).toHaveText(`(${long.host})`);
        expect(await identityLayout(card), label).toEqual({ pageScrolls: false, cardOverflows: false, outside: [] });
      }
    }
  });

  test('a long title on a link post is cut short in Compact, never its domain, and wraps whole in Classic', async ({
    page,
    context,
    baseURL,
  }) => {
    const { title } = names;
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const density of ['compact', 'classic']) {
        await context.addCookies([{ name: 'peblish_prefs', value: `density=${density}&scheme=system`, url: baseURL! }]);
        await gotoHydrated(page, '/all?sort=new');
        const card = page.locator('.feed-list article', { has: page.locator(`a[href="/post/${title.id}"]`) }).first();
        await expect(card).toHaveAttribute('data-density', density);
        await expect(card.locator('.pb-post__domain')).toHaveText(`(${title.domain})`);
        const layout = await card.evaluate((article) => {
          const title = article.querySelector('.pb-post__title')!;
          const link = title.querySelector('a')!;
          const domain = title.querySelector('.pb-post__domain')!.getBoundingClientRect();
          const box = title.getBoundingClientRect();
          return {
            titleCut: link.scrollWidth > link.clientWidth + 1,
            oneLine: box.height < 2 * parseFloat(getComputedStyle(link).lineHeight) - 1,
            domainShown:
              domain.width > 0 &&
              domain.left >= box.left - 0.5 &&
              domain.right <= box.right + 0.5 &&
              domain.top >= box.top - 0.5 &&
              domain.bottom <= box.bottom + 0.5,
          };
        });
        expect(layout, `${density} at ${width}px`).toEqual(
          density === 'compact'
            ? { titleCut: true, oneLine: true, domainShown: true }
            : { titleCut: false, oneLine: false, domainShown: true },
        );
      }
    }
  });

  test('a remote title with a right-to-left override is isolated and drawn without it, in the feed and on its page', async ({ page }) => {
    const { hostile } = names;
    const controls = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
    const plain = hostile.title.replace(controls, '');
    await gotoHydrated(page, '/all?sort=new');
    const title = page.locator(`.pb-post__title a[href="/post/${hostile.id}"]`).first();
    await expect(title.locator('bdi')).toHaveText(plain);
    expect(await title.textContent()).not.toMatch(controls);
    await gotoHydrated(page, `/post/${hostile.id}`);
    const heading = page.getByRole('heading', { level: 1, name: plain });
    await expect(heading.locator('bdi')).toHaveText(plain);
    expect(await heading.textContent()).not.toMatch(controls);
  });

  test('a directional override in a remote username cannot move or reverse the host', async ({ page }) => {
    const { hostile } = names;
    await gotoHydrated(page, '/all?sort=new');
    const handle = page
      .locator('.feed-list article', { has: page.locator(`a[href="/post/${hostile.id}"]`) })
      .first()
      .locator('.pb-post__by .pb-handle');
    const host = handle.locator('.pb-handle__host');
    await expect(host).toHaveText(`@${hostile.host}`);
    const drawn = await handle.evaluate((element) => {
      const name = element.querySelector('.pb-handle__name')!;
      const host = element.querySelector('.pb-handle__host')!;
      const text = host.firstChild!;
      const char = (index: number) => {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        return range.getBoundingClientRect();
      };
      const last = text.textContent!.length - 1;
      return {
        // The name's text shows no control character: each is a replacement mark.
        nameHasControls: /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(name.textContent!),
        // The host starts where the name ends, on the same line, and reads left to right.
        hostAfterName: host.getBoundingClientRect().left >= name.getBoundingClientRect().right - 0.5,
        hostLeftToRight: char(0).left < char(1).left && char(1).left < char(last).left,
      };
    });
    expect(drawn).toEqual({ nameHasControls: false, hostAfterName: true, hostLeftToRight: true });
  });
});

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the toolbar speaks German, with no axe violations', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    await expect(page.getByRole('navigation', { name: 'Sortierung' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Top aus' }).getByRole('link', { name: 'Woche' })).toBeVisible();
    await expectAccessible(page);
  });

  test('each post and its vote group are named by the title, in German', async ({ page }) => {
    await gotoHydrated(page, '/all?sort=top');
    const title = `Picture ${seed.suffix}`;
    const card = page.getByRole('article', { name: title });
    await expect(card.getByRole('group', { name: `Über „${title}“ abstimmen`, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Hochstimmen' })).toBeVisible();
  });
});

test.describe('a viewer', () => {
  test('home is Subscribed: what they follow and nothing else, with their own lists in the sidebar', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Subscribed');
    const list = await titles(page);
    // Hot puts the best scored and newest first.
    expect(list[0]).toBe(`Picture ${seed.suffix}`);
    expect(list.some((title) => title.startsWith('Other ') || title.startsWith('Local '))).toBe(false);
    const side = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(side.getByRole('link', { name: 'Subscribed' })).toBeVisible();
    await expect(side.getByRole('link', { name: 'Moderating' })).toBeVisible();
    await expect(side.getByRole('link', { name: new RegExp(`^!${seed.communities.remote}@`) })).toBeVisible();
    await expect(side.getByRole('navigation', { name: 'Communities' })).toContainText('Remote (1)');
    await expectAccessible(page);
  });

  test('Moderating is the posts of the communities they moderate', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/moderating?sort=new');
    expect(await titles(page)).toEqual([`Local ${seed.suffix}`]);
  });

  test('next pages join up in order, by link and by the first-page link', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const first = await titles(page);
    expect(first).toHaveLength(20);
    expect(first.slice(0, 2)).toEqual([`Picture ${seed.suffix}`, `Followed ${seed.suffix} 01`]);
    await page.getByRole('link', { name: 'Next page' }).click();
    await page.waitForURL(/\?sort=new&cursor=/);
    await expect.poll(() => titles(page)).not.toEqual(first);
    const second = await titles(page);
    expect(second).toHaveLength(20);
    expect(second[0]).toBe(`Followed ${seed.suffix} 20`);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect.poll(() => titles(page)).not.toEqual(second);
    const third = await titles(page);
    expect(third.at(-1)).toBe(`Followed ${seed.suffix} 45`);
    expect([...first, ...second, ...third]).toHaveLength(46);
    await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to the first page' }).click();
    await page.waitForURL('**/?sort=new');
    expect(await titles(page)).toEqual(first);
  });

  test('a vote from the feed is kept', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const card = page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 02` });
    const up = card.getByRole('button', { name: 'Upvote' });
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await up.click();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await expect(async () => {
      await page.reload();
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(
        page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 02` }).getByRole('button', { name: 'Upvote' }),
      ).toHaveAttribute('aria-pressed', 'true');
    }).toPass();
  });

  test('a vote whose request fails goes back, and one message says it was not saved', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const cards = [3, 4].map((n) => page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 0${n}` }));
    const ids = await Promise.all(
      cards.map(async (card) => (await card.locator('.pb-post__title a').getAttribute('href'))!.split('/').pop()!),
    );
    await page.route(
      (url) => url.pathname.includes('/_serverFn/'),
      (route) => (ids.some((id) => isVoteOn(id)(route.request())) ? route.abort('failed') : route.fallback()),
    );
    // Two votes in a burst, both refused by the network: two rollbacks, one message.
    const before = await Promise.all(cards.map((card) => card.locator('.pb-vote__score').textContent()));
    for (const card of cards) await card.getByRole('button', { name: 'Upvote' }).click();
    const toast = page.locator('.muxui-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Vote not saved');
    await expect(toast).toContainText('Your vote was not saved. Try again in a moment.');
    // Announced: React Aria's toast content is an alert.
    await expect(toast.getByRole('alert')).toContainText('Vote not saved');
    for (const [index, card] of cards.entries()) {
      await expect(card.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'false');
      await expect(card.locator('.pb-vote__score')).toHaveText(before[index]!);
    }
    await expect(toast).toHaveCount(1);
  });

  test('a vote still being saved survives a switch through all three densities', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/?sort=new');
    const card = page.locator('.feed-list article', { hasText: `Followed ${seed.suffix} 05` });
    const id = (await card.locator('.pb-post__title a').getAttribute('href'))!.split('/').pop()!;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname.includes('/_serverFn/'),
      async (route) => {
        if (isVoteOn(id)(route.request())) await gate;
        await route.fallback();
      },
    );
    const up = card.getByRole('button', { name: 'Upvote' });
    const score = Number(await card.locator('.pb-vote__score').textContent());
    const saved = page.waitForResponse((response) => isVoteOn(id)(response.request()));
    await up.click();
    for (const density of ['Card', 'Classic', 'Compact'] as const) {
      await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: density }).click();
      await expect(card).toHaveAttribute('data-density', density.toLowerCase());
      await expect(up, density).toHaveAttribute('aria-pressed', 'true');
      await expect(card.locator('.pb-vote__score'), density).toHaveText(String(score + 1));
    }
    release();
    expect((await saved).ok()).toBe(true);
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('.pb-vote__score')).toHaveText(String(score + 1));
  });

  test('a person who has declared 16+ gets the sensitive post hidden behind show; one who has not does not get it', async ({ page }) => {
    await signedIn(page, seed.viewer.name);
    await gotoHydrated(page, '/all?sort=top');
    const card = page.locator('.feed-list article[data-sensitive]', { hasText: `Sensitive ${seed.suffix}` });
    await expect(card).toHaveAttribute('data-hidden', 'true');
    await card.getByRole('button', { name: 'hidden, show' }).click();
    await expect(card).not.toHaveAttribute('data-hidden');
    await page.context().clearCookies();
    await signedIn(page, seed.undeclared.name);
    expect(await html(page, '/all?sort=top')).not.toContain(`Sensitive ${seed.suffix}`);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the sort and the next page are plain links', async ({ page }) => {
    await page.goto('/all?sort=new');
    const first = await postLinks(page);
    expect(first).toHaveLength(20);
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/cursor=/);
    const second = await postLinks(page);
    expect(second).toHaveLength(20);
    expect(second.filter((link) => first.includes(link))).toEqual([]);
    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Top' }).click();
    await expect(page).toHaveURL(/sort=top/);
    expect((await titles(page))[0]).toBe(`Picture ${seed.suffix}`);
  });
});
