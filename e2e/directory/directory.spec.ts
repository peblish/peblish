import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane DISC end to end, on the built server and the lane database: the community directory
// (public, signed in with and without a 16+ declaration, Join and Leave with and without script)
// and the resolve page (signed out, signed in, errors, a seeded remote handle sent to its local
// page). No request leaves the machine: a lookup that would need a peer is never made here.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  localHost: string;
  viewer: { name: string };
  undeclared: { name: string };
  host: string;
  communities: { local: string; adult: string; remote: string; remoteAdult: string };
  remotePerson: string;
};

let seed: Seed;
let viewerState: Awaited<ReturnType<BrowserContext['storageState']>>;
let undeclaredState: typeof viewerState;

async function stateOf(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ browser }) => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-disc.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
  viewerState = await stateOf(browser, seed.viewer.name);
  undeclaredState = await stateOf(browser, seed.undeclared.name);
});

async function as(
  browser: Browser,
  state: typeof viewerState | null,
  options: { javaScriptEnabled?: boolean; locale?: string; viewport?: { width: number; height: number } } = {},
) {
  const context = await browser.newContext({ ...(state && { storageState: state }), ...options });
  return { context, page: await context.newPage() };
}

/** The server-rendered HTML of `path` for this page's session, before any script runs. */
async function html(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'commit' });
  if (!response) throw new Error('no response');
  return response.text();
}

/**
 * A form post made by the page's own browser, which holds the session cookie (the API client
 * does not send the Secure cookies of an https instance over http). Redirects are followed:
 * `url` is where the 303 led, `redirected` says there was one.
 */
async function post(page: Page, path: string, form: Record<string, string>, json = false) {
  return page.evaluate(
    async ({ path, form, json }) => {
      const response = await fetch(path, {
        method: 'POST',
        body: new URLSearchParams(form),
        headers: json ? { accept: 'application/json' } : {},
      });
      return {
        status: response.status,
        url: new URL(response.url).pathname + new URL(response.url).search,
        redirected: response.redirected,
        text: json ? await response.text() : '',
      };
    },
    { path, form, json },
  );
}

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });
const search = (extra = '') => `/communities?q=${seed.suffix}${extra}`;

test.describe('the directory, signed out', () => {
  test('hydrates, lists local and remote communities with their source, and has no axe violations', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, search());
    await expect(page.getByRole('heading', { level: 1, name: 'Communities' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Scope' }).getByRole('link', { name: /^All 2$/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('navigation', { name: 'Scope' }).getByRole('link', { name: /^Local 1$/ })).toBeVisible();
    await expect(row(page, seed.communities.local)).toContainText('local');
    await expect(row(page, seed.communities.remote)).toContainText(`${seed.host} · local copy refreshed`);
    await expect(row(page, seed.communities.remote).getByRole('link', { name: 'Sign in to join' })).toHaveAttribute(
      'href',
      `/auth/sign-in?redirect=${encodeURIComponent(search())}`,
    );
    await expect(page.getByRole('link', { name: 'A to Z' })).toBeVisible();
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('hydrates in German', async ({ browser }) => {
    const { context, page } = await as(browser, null, { locale: 'de-DE' });
    const log = recordConsole(page);
    await gotoHydrated(page, search());
    await expect(page.getByRole('heading', { level: 1, name: 'Communitys' })).toBeVisible();
    await expect(row(page, seed.communities.remote)).toContainText('lokale Kopie vor');
    expect(log.hydrationProblems()).toEqual([]);
    await context.close();
  });

  test('never sends an age-gated community or an NSFW control, and nsfw=show acts as Hide', async ({ page }) => {
    for (const path of [search(), search('&nsfw=show'), search('&nsfw=only')]) {
      const text = await html(page, path);
      expect(text, path).not.toContain(seed.communities.adult);
      expect(text, path).not.toContain(seed.communities.remoteAdult);
      expect(text, path).not.toContain('NSFW');
      expect(text, path).toContain(seed.communities.local);
    }
  });

  test('the sort, the scope and the search are plain links and a GET form', async ({ page }) => {
    await gotoHydrated(page, search());
    await page
      .getByRole('navigation', { name: 'Scope' })
      .getByRole('link', { name: /^Local/ })
      .click();
    await page.waitForURL(/scope=local/);
    await expect(row(page, seed.communities.local)).toBeVisible();
    await expect(row(page, seed.communities.remote)).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Newest' }).click();
    await page.waitForURL(/sort=newest/);
    await expect(page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'Newest' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.getByRole('searchbox', { name: 'Search communities' }).fill(`${seed.suffix} nothing`);
    await page.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForURL(/q=.*nothing/);
    await expect(page.getByRole('heading', { name: 'No communities match' })).toBeVisible();
    // The scope and sort survive a search.
    expect(page.url()).toMatch(/scope=local/);
    expect(page.url()).toMatch(/sort=newest/);
  });

  test('the search is sent by Enter, and without JavaScript by the button and by Enter', async ({ page, browser }) => {
    const field = (on: Page) => on.getByRole('searchbox', { name: 'Search communities' });
    await gotoHydrated(page, '/communities?scope=local');
    await field(page).fill(seed.communities.local);
    await field(page).press('Enter');
    await page.waitForURL(/[?&]q=/);
    expect(new URL(page.url()).searchParams.get('q')).toBe(seed.communities.local);
    expect(page.url()).toMatch(/scope=local/);
    await expect(row(page, seed.communities.local)).toBeVisible();

    const { context, page: plain } = await as(browser, null, { javaScriptEnabled: false });
    await plain.goto('/communities?sort=newest');
    await field(plain).fill(`${seed.suffix} nothing`);
    await plain.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
    await plain.waitForURL(/[?&]q=/);
    expect(new URL(plain.url()).searchParams.get('q')).toBe(`${seed.suffix} nothing`);
    expect(plain.url()).toMatch(/sort=newest/);
    await expect(plain.getByRole('heading', { name: 'No communities match' })).toBeVisible();
    await field(plain).fill(seed.communities.remote);
    await field(plain).press('Enter');
    await plain.waitForURL((url) => url.searchParams.get('q') === seed.communities.remote);
    await expect(row(plain, seed.communities.remote)).toBeVisible();
    await context.close();
  });

  test('on a phone the table scrolls inside its own box and the page never scrolls sideways', async ({ browser }) => {
    for (const width of [375, 320]) {
      const { context, page } = await as(browser, null, { viewport: { width, height: 800 } });
      await gotoHydrated(page, search());
      await expect(row(page, seed.communities.local)).toBeVisible();
      const geometry = await page.evaluate(() => {
        const box = document.querySelector('.dir-scroll');
        // Asking the page to scroll sideways shows what a swipe would reach, whatever escapes the box.
        window.scrollTo(10_000, 0);
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          scrolledX: window.scrollX,
          box: box ? box.scrollWidth - box.clientWidth : -1,
        };
      });
      // The rows are wider than the phone, so the box scrolls; the page does not.
      expect(geometry.box, `${width}px`).toBeGreaterThan(0);
      expect([width, geometry.page, geometry.scrolledX]).toEqual([width, 0, 0]);
      await context.close();
    }
  });

  test('a search that looks like a handle offers to find it and leaves the list whole', async ({ page }) => {
    await gotoHydrated(page, `/communities?q=${encodeURIComponent('!lab@lemmy.example')}`);
    await expect(page.getByText('That looks like a handle or a link.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Find it on its own server' })).toHaveAttribute(
      'href',
      `/resolve?q=${encodeURIComponent('!lab@lemmy.example')}`,
    );
    expect(await page.getByRole('row').count()).toBeGreaterThan(2);
  });
});

test.describe('the directory, signed in', () => {
  test('a person who declared 16+ chooses NSFW: local communities only, never a remote one', async ({ browser }) => {
    const { context, page } = await as(browser, viewerState);
    const log = recordConsole(page);
    await gotoHydrated(page, search());
    const nsfw = page.getByRole('navigation', { name: 'NSFW' });
    await expect(nsfw.getByRole('link', { name: 'Hide NSFW' })).toHaveAttribute('aria-current', 'page');
    await expect(row(page, seed.communities.adult)).toHaveCount(0);
    await expectAccessible(page);

    await nsfw.getByRole('link', { name: 'Show NSFW' }).click();
    await page.waitForURL(/nsfw=show/);
    await expect(row(page, seed.communities.adult).getByText('NSFW', { exact: true })).toBeVisible();
    await expect(row(page, seed.communities.local)).toBeVisible();
    await expect(row(page, seed.communities.remoteAdult)).toHaveCount(0);

    await page.getByRole('navigation', { name: 'NSFW' }).getByRole('link', { name: 'Only NSFW' }).click();
    await page.waitForURL(/nsfw=only/);
    await expect(row(page, seed.communities.adult)).toBeVisible();
    await expect(row(page, seed.communities.local)).toHaveCount(0);
    expect(log.hydrationProblems()).toEqual([]);
    await context.close();
  });

  test('the scope, sort, NSFW choice, search and page keep each other when combined, and a new search starts at page 1', async ({
    browser,
  }) => {
    const { context, page } = await as(browser, viewerState, { javaScriptEnabled: false });
    const q = seed.suffix;
    await page.goto(`/communities?scope=local&sort=newest&nsfw=show&q=${q}&page=2`);
    /** The parts of a link's address, sorted so the order does not matter. */
    const parts = async (link: ReturnType<Page['getByRole']>) => {
      const href = await link.getAttribute('href');
      return [...new URL(href ?? '', 'http://x').searchParams].sort(([a], [b]) => a.localeCompare(b));
    };
    const nav = (name: string) => page.getByRole('navigation', { name });
    expect(await parts(nav('Scope').getByRole('link', { name: /^All/ }))).toEqual([
      ['nsfw', 'show'],
      ['q', q],
      ['sort', 'newest'],
    ]);
    expect(await parts(nav('Sort').getByRole('link', { name: 'A to Z' }))).toEqual([
      ['nsfw', 'show'],
      ['q', q],
      ['scope', 'local'],
      ['sort', 'name'],
    ]);
    expect(await parts(nav('NSFW').getByRole('link', { name: 'Only NSFW' }))).toEqual([
      ['nsfw', 'only'],
      ['q', q],
      ['scope', 'local'],
      ['sort', 'newest'],
    ]);
    // Page 2 links back to page 1 with everything else.
    expect(await parts(page.getByRole('link', { name: /Previous/ }))).toEqual([
      ['nsfw', 'show'],
      ['q', q],
      ['scope', 'local'],
      ['sort', 'newest'],
    ]);
    // A search keeps the scope, the sort and the NSFW choice and goes back to page 1.
    await page.getByRole('searchbox', { name: 'Search communities' }).fill(seed.communities.adult);
    await page.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('q') === seed.communities.adult);
    expect([...new URL(page.url()).searchParams].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['nsfw', 'show'],
      ['q', seed.communities.adult],
      ['scope', 'local'],
      ['sort', 'newest'],
    ]);
    await expect(row(page, seed.communities.adult)).toBeVisible();
    await context.close();
  });

  test('a person who has not declared 16+ gets no NSFW controls and no age-gated community in the page', async ({ browser }) => {
    const { context, page } = await as(browser, undeclaredState);
    for (const path of [search(), search('&nsfw=show')]) {
      const text = await html(page, path);
      expect(text, path).not.toContain(seed.communities.adult);
      expect(text, path).not.toContain('NSFW');
      expect(text, path).toContain(seed.communities.local);
    }
    await context.close();
  });

  test('Join and Leave a local community, and Join a remote one that stays Pending', async ({ browser }) => {
    const { context, page } = await as(browser, viewerState);
    await gotoHydrated(page, search());
    // "New community" is for site admins (e2e/communities checks they get it).
    await expect(page.getByRole('link', { name: 'New community' })).toHaveCount(0);
    const local = row(page, seed.communities.local);
    await expect(local.getByRole('button', { name: 'Join' })).toBeVisible();
    await local.getByRole('button', { name: 'Join' }).click();
    await expect(local.getByRole('button', { name: 'Joined' })).toBeVisible();
    await expect(local).toContainText('1');
    await local.getByRole('button', { name: 'Joined' }).click();
    await expect(local.getByRole('button', { name: 'Join' })).toBeVisible();

    const remote = row(page, seed.communities.remote);
    await remote.getByRole('button', { name: 'Join' }).click();
    await expect(remote.getByRole('button', { name: 'Pending' })).toBeDisabled();
    await expectAccessible(page);
    await context.close();
  });

  test('Join and Leave without JavaScript go back to the same page', async ({ browser }) => {
    const { context, page } = await as(browser, viewerState, { javaScriptEnabled: false });
    await page.goto(search());
    const local = row(page, seed.communities.local);
    await local.getByRole('button', { name: 'Join' }).click();
    await page.waitForURL(search());
    await expect(row(page, seed.communities.local).getByRole('button', { name: 'Joined' })).toBeVisible();
    await row(page, seed.communities.local).getByRole('button', { name: 'Joined' }).click();
    await page.waitForURL(search());
    await expect(row(page, seed.communities.local).getByRole('button', { name: 'Join' })).toBeVisible();
    await context.close();
  });

  test('a refused join says why, with and without script', async ({ browser, page }) => {
    // A community that does not exist: the form post names it by a made-up id.
    const body = { community: '0192f2c0-0000-7000-8000-00000000dead', intent: 'join', next: '/communities?sort=active' };
    const { context, page: signed } = await as(browser, viewerState);
    await gotoHydrated(signed, '/communities');
    const plain = await post(signed, '/communities/follow', body);
    expect(plain).toMatchObject({ redirected: true, url: '/communities?sort=active&error=target.not_found' });
    const json = await post(signed, '/communities/follow', body, true);
    expect([json.status, JSON.parse(json.text)]).toEqual([400, { error: 'target.not_found' }]);
    await signed.goto('/communities?sort=active&error=target.not_found');
    await expect(signed.getByRole('alert')).toHaveText('That community was not found.');
    await context.close();
    // Signed out, nothing is joined.
    const anonymous = await page.request.post('/communities/follow', { form: body, maxRedirects: 0 });
    expect(anonymous.headers().location).toBe('/communities?sort=active&error=auth.required');
  });
});

test.describe('resolve', () => {
  test('signed out: the page asks to sign in and offers no form', async ({ page }) => {
    const log = recordConsole(page);
    await gotoHydrated(page, '/resolve?q=%21lab%40lemmy.example');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find a community, person or post');
    await expect(page.getByRole('heading', { name: 'Sign in to find things on other servers' })).toBeVisible();
    // The page offers no field; the shell's own sidebar filter is outside main.
    await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
    const answer = await page.request.post('/resolve', { form: { q: '!lab@lemmy.example' }, headers: { accept: 'application/json' } });
    expect([answer.status(), await answer.json()]).toEqual([400, { error: 'auth.required' }]);
  });

  test('signed in: ?q= only prefills the field, and the page passes axe in English and German', async ({ browser }) => {
    for (const locale of ['en-US', 'de-DE']) {
      const { context, page } = await as(browser, viewerState, { locale });
      const log = recordConsole(page);
      await gotoHydrated(page, '/resolve?q=%21lab%40lemmy.example');
      await expect(page.getByRole('textbox', { name: locale === 'en-US' ? 'Handle or link' : 'Adresse oder Link' })).toHaveValue(
        '!lab@lemmy.example',
      );
      if (locale === 'en-US') {
        await expect(page.getByText('Accepts !name@host, @name@host or a link to a community, person, post or comment')).toBeVisible();
        await expectAccessible(page);
      }
      expect(log.hydrationProblems()).toEqual([]);
      await context.close();
    }
  });

  test('says why a lookup failed, in place, with no request to another server', async ({ browser }) => {
    const { context, page } = await as(browser, viewerState);
    await gotoHydrated(page, '/resolve');
    const field = page.getByRole('textbox', { name: 'Handle or link' });
    await field.fill('not a lookup');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByRole('alert')).toContainText('That is not a handle or link we can use.');
    // This server's own host is never asked about.
    await field.fill(`!nothing_${seed.suffix}@${seed.localHost}`);
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByRole('alert')).toContainText('Nothing was found there.');
    await expect(field).toHaveValue(`!nothing_${seed.suffix}@${seed.localHost}`);
    await context.close();
  });

  test('a handle we hold goes to its local page: hydrated, and with a plain form post', async ({ browser }) => {
    const handle = `${seed.communities.remote}@${seed.host}`;
    const { context, page } = await as(browser, viewerState);
    await gotoHydrated(page, '/resolve');
    await page.getByRole('textbox', { name: 'Handle or link' }).fill(`!${handle}`);
    await page.getByRole('button', { name: 'Find' }).click();
    await page.waitForURL(`**/c/${handle}`);
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toHaveCount(0);

    // The same without script, and a link to the community instead of its handle.
    for (const q of [`!${handle}`, `https://${seed.host}/c/${seed.communities.remote}`]) {
      const json = await post(page, '/resolve', { q }, true);
      expect([json.status, JSON.parse(json.text)]).toEqual([200, { redirect: `/c/${handle}` }]);
    }
    const plain = await as(browser, viewerState, { javaScriptEnabled: false });
    await plain.page.goto('/resolve');
    await plain.page.getByRole('textbox', { name: 'Handle or link' }).fill(`!${handle}`);
    await plain.page.getByRole('button', { name: 'Find' }).click();
    await plain.page.waitForURL(`**/c/${handle}`);
    // And a failure comes back to the form with the code and the words typed.
    await plain.page.goto('/resolve');
    await plain.page.getByRole('textbox', { name: 'Handle or link' }).fill('nonsense');
    await plain.page.getByRole('button', { name: 'Find' }).click();
    await plain.page.waitForURL(/error=input\.invalid/);
    await expect(plain.page.getByRole('alert')).toContainText('That is not a handle or link we can use.');
    await expect(plain.page.getByRole('textbox', { name: 'Handle or link' })).toHaveValue('nonsense');
    await plain.context.close();
    await context.close();
  });

  test('Cancel stops a pending lookup; Try again sends it again, hydrated and without JavaScript', async ({ browser }) => {
    const handle = `${seed.communities.remote}@${seed.host}`;
    const { context, page } = await as(browser, viewerState);
    // The other server is stood in for: the first lookup never answers, the second answers late as unreachable.
    let calls = 0;
    await page.route('**/resolve', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      calls += 1;
      if (calls === 1) return; // left hanging until the page aborts it
      if (calls === 2) return route.fulfill({ status: 504, json: { error: 'peer.unreachable' } });
      return route.continue();
    });
    await gotoHydrated(page, '/resolve');
    await page.getByRole('textbox', { name: 'Handle or link' }).fill(`!${handle}`);
    await page.getByRole('button', { name: 'Find' }).click();
    const pending = page.getByRole('status').filter({ hasText: `Asking ${seed.host}` });
    await expect(pending).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find' })).toBeDisabled();
    await pending.getByRole('button', { name: 'Cancel' }).click();
    await expect(pending).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find' })).toBeEnabled();

    await page.getByRole('button', { name: 'Find' }).click();
    const failed = page.getByRole('alert');
    await expect(failed).toContainText('That server did not answer in time.');
    await failed.getByRole('button', { name: 'Try again' }).click();
    await page.waitForURL(`**/c/${handle}`);
    expect(calls).toBe(3);
    await context.close();

    // Without script the refusal comes back in the address, and Try again posts the same words again.
    const plain = await as(browser, viewerState, { javaScriptEnabled: false });
    await plain.page.goto(`/resolve?q=${encodeURIComponent(`!${handle}`)}&error=peer.unreachable`);
    await expect(plain.page.getByRole('alert')).toContainText('That server did not answer in time.');
    await plain.page.getByRole('button', { name: 'Try again' }).click();
    await plain.page.waitForURL(`**/c/${handle}`);
    await plain.context.close();
  });

  test('a held remote community and person open on their pages here, not a not-found page', async ({ browser }) => {
    const { context, page } = await as(browser, viewerState);
    await gotoHydrated(page, '/resolve');
    const community = `${seed.communities.remote}@${seed.host}`;
    const person = `${seed.remotePerson}@${seed.host}`;
    for (const [q, path] of [
      [`!${community}`, `/c/${community}`],
      [`@${person}`, `/u/${person}`],
    ] as const) {
      const json = await post(page, '/resolve', { q }, true);
      expect([q, json.status, JSON.parse(json.text)]).toEqual([q, 200, { redirect: path }]);
      const response = await page.goto(path, { waitUntil: 'commit' });
      expect([path, response?.status()]).toEqual([path, 200]);
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' }), path).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
    }
    await context.close();
  });
});
