import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { contrast } from '../support/contrast.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Text contrast in the sidebar and the header, in each scheme chosen through the Appearance
// control as a person does (not by setting the attribute). Both sit on the page's own surface
// (Commons). Text needs 4.5:1 (WCAG AA), the nav icons 3:1 (non-text).
test.use({ viewport: { width: 1280, height: 800 } });

/** Appearance is a visitor's own control in the header, and a signed-in viewer's in the account menu. */
async function choose(page: Page, scheme: 'Light' | 'Dark') {
  const banner = page.getByRole('banner');
  if (await banner.getByRole('button', { name: 'Appearance' }).count()) {
    await banner.getByRole('button', { name: 'Appearance' }).click();
    await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: scheme }).click();
    await page.keyboard.press('Escape');
  } else {
    await banner.getByRole('button', { name: /^Account:/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: scheme }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', scheme.toLowerCase());
  // Mux eases Button colours on a scheme change (a resting Link no longer since rc.7): measure once
  // every transition has ended (or was cancelled).
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
}

/** Each sample's contrast, printed so the numbers are in the run's log. */
async function measure(page: Page, label: string, samples: Record<string, Locator>, minimum: Record<string, number> = {}) {
  for (const [name, target] of Object.entries(samples)) {
    const ratio = await contrast(target);
    console.log(`contrast ${label} ${name}: ${ratio}`);
    expect(ratio, `${label} ${name}`).toBeGreaterThanOrEqual(minimum[name] ?? 4.5);
  }
}

const navigation = (page: Page) =>
  page.getByRole('complementary', { name: 'Sidebar' }).getByRole('navigation', { name: 'Feeds and communities' });

const sidebar = (page: Page) => {
  const nav = navigation(page);
  return {
    'sidebar link': nav.getByRole('link', { name: 'Local', exact: true }).locator('.muxui-sidebar__nav-label'),
    'sidebar current item': nav.getByRole('link', { name: 'All', exact: true }).locator('.muxui-sidebar__nav-label'),
    'sidebar section label': nav.locator('.muxui-sidebar__section-label').first(),
    'sidebar footer link': nav.getByRole('link', { name: 'Code of conduct' }).locator('.muxui-sidebar__nav-label'),
    'sidebar icon': nav.getByRole('link', { name: 'Local', exact: true }).locator('svg'),
  };
};

for (const scheme of ['Light', 'Dark'] as const) {
  test(`in ${scheme}, chosen through Appearance, the sidebar and the header text reach 4.5:1`, async ({ page, browser }) => {
    await gotoHydrated(page, '/all');
    await choose(page, scheme);
    await expect(navigation(page).getByRole('link', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'page');
    const top = page.getByRole('banner');
    await page.screenshot({ path: test.info().outputPath(`${scheme.toLowerCase()}.png`) });
    await measure(
      page,
      `${scheme} signed out`,
      {
        ...sidebar(page),
        'header finder': top.getByRole('link', { name: 'Find a community' }),
        'header Sign in': top.getByRole('link', { name: 'Sign in' }),
        'header Sign up': top.getByRole('link', { name: 'Sign up' }),
        'header Appearance': top.getByRole('button', { name: 'Appearance' }),
      },
      { 'sidebar icon': 3 },
    );

    test.skip(Boolean(process.env.BASE_URL), 'the signed-in half needs the lane database for its seed (DATABASE_URL)');
    const { password, people } = JSON.parse(
      execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
    ) as { password: string; people: [string, string] };
    const signedIn = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await gotoHydrated(signedIn, '/auth/sign-in');
    await signIn(signedIn, `@${people[0]}`, password);
    await landed(signedIn, '/');
    await choose(signedIn, scheme);
    const bar = signedIn.getByRole('banner');
    await measure(signedIn, `${scheme} signed in`, {
      'header Create post': bar.getByRole('link', { name: 'Create post' }),
      'header Inbox': bar.getByRole('link', { name: /^Inbox/ }),
      // The menu's button, the viewer's initial; the no-script link beside it is not displayed with scripts on.
      'header account initial': bar.locator('button.pb-account__trigger .muxui-avatar'),
    });
    await signedIn.context().close();
  });
}

// Links are Mux Link as it comes (link colour) or quiet in muted text (pb-link-muted, link.css),
// and sit on the page, on raised cards and on quiet fills. Axe sees the links a page happens to
// show; this measures each colour on each surface, at rest and hovered, whatever the seed shows.
// (The sidebar's links and the header's are measured above.)
const surfaces = ['surface-background', 'surface-raised', 'surface-subtle'] as const;
const inks = ['content-link', 'content-link-hover', 'content-muted'] as const;
for (const scheme of ['Light', 'Dark'] as const) {
  test(`in ${scheme}, link and muted text reach 4.5:1 on the page, raised and subtle surfaces`, async ({ page }) => {
    await gotoHydrated(page, '/all');
    await choose(page, scheme);
    await page
      .locator('main')
      .first()
      .evaluate(
        (main, [surfaces, inks]) => {
          for (const surface of surfaces) {
            const box = main.appendChild(document.createElement('div'));
            box.style.background = `var(--muxui-semantic-${surface})`;
            for (const ink of inks) {
              const sample = box.appendChild(document.createElement('span'));
              sample.dataset.sample = `${ink} on ${surface}`;
              sample.style.color = `var(--muxui-semantic-${ink})`;
              sample.textContent = 'Aa';
            }
          }
        },
        [surfaces, inks] as const,
      );
    const samples = Object.fromEntries(
      surfaces.flatMap((surface) => inks.map((ink) => [`${ink} on ${surface}`, page.locator(`[data-sample="${ink} on ${surface}"]`)])),
    );
    await measure(page, scheme, samples);
  });
}

// The feddit pack's focus rings (packages/ui/src/brand/feddit/pack.css). Mux draws two: its brand ring (links,
// buttons) and a neutral one (checkboxes, switches, a field's focus edge). Under the pack the neutral ring is the
// pack's brand 60, so both reach 3:1 (WCAG 1.4.11) on every ground the pack's neutrals make, in both schemes. The
// pack's sheet is put in the page, so site.brand is left alone (its face is left out: the wordmark is not measured).
const packSheet = readFileSync(join(import.meta.dirname, '../../packages/ui/src/brand/feddit/pack.css'), 'utf8').replace(
  /@font-face\s*\{[^}]*\}/g,
  '',
);
const grounds = ['surface-background', 'surface-canvas', 'surface-raised', 'surface-subtle', 'surface-hover'] as const;
const rings = ['focus-ring', 'focus-neutral-ring'] as const;
for (const scheme of ['Light', 'Dark'] as const) {
  test(`under the feddit pack in ${scheme}, both focus rings reach 3:1 on every ground`, async ({ page }) => {
    await gotoHydrated(page, '/all');
    await choose(page, scheme);
    await page.addStyleTag({ content: packSheet });
    const resolve = (name: string) =>
      page.evaluate((name) => {
        const probe = document.body.appendChild(document.createElement('span'));
        probe.style.color = `var(${name})`;
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      }, name);
    expect(await resolve('--muxui-semantic-focus-neutral-ring')).toBe(await resolve('--muxui-reference-color-brand-60'));
    await page
      .locator('main')
      .first()
      .evaluate(
        (main, [grounds, rings]) => {
          for (const ground of grounds) {
            const box = main.appendChild(document.createElement('div'));
            box.style.background = `var(--muxui-semantic-${ground})`;
            for (const ring of rings) {
              const sample = box.appendChild(document.createElement('span'));
              sample.dataset.sample = `${ring} on ${ground}`;
              sample.style.color = `var(--muxui-semantic-${ring})`;
              sample.textContent = 'Aa';
            }
          }
        },
        [grounds, rings] as const,
      );
    const samples = grounds.flatMap((ground) => rings.map((ring) => `${ring} on ${ground}`));
    await measure(
      page,
      `${scheme} feddit`,
      Object.fromEntries(samples.map((name) => [name, page.locator(`[data-sample="${name}"]`)])),
      Object.fromEntries(samples.map((name) => [name, 3])),
    );
  });
}
