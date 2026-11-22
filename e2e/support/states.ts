import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page } from '@playwright/test';
import { colours } from './contrast.ts';
import { prefsCookie } from './kit.ts';
import { gotoHydrated } from './route-marker.ts';

// The gallery's state pages (/kit/<composition>, packages/web/src/routes/kit/$composition.tsx) render a composition
// once for each state it takes as a prop, each sample in a `[data-kit-state]` section. This drives the rest sample
// into the states a person makes (hovered, focused from the keyboard, pressed) and, for every state, in light and
// dark, under forced colours, under reduced motion and at a phone's width, records what it measures.

/** The states a page shows as samples, in the state matrix's order ('selected' covers current, checked, expanded). */
export const shownStates = ['rest', 'selected', 'disabled', 'pending', 'invalid'] as const;
/** The states driven on the rest sample's target (its `[data-kit-target]`, else its first control). */
export const drivenStates = ['hover', 'focus', 'pressed'] as const;
export type KitState = (typeof shownStates)[number] | (typeof drivenStates)[number];
export const conditions = ['default', 'forced colours', 'reduced motion', 'phone'] as const;
export type Condition = (typeof conditions)[number];

export interface StateCheck {
  scheme: 'light' | 'dark';
  condition: Condition;
  state: KitState;
  /** axe's violations in the state's section, as `rule: target`. */
  axe: string[];
  /** The lowest contrast of the sample's text (e2e/support/contrast.ts). */
  text?: number;
  /** The target's icons against what is behind them. */
  icon?: number;
  /** Focus only: the ring around the target (an outline outside it, or a solid box-shadow ring). */
  ring?: number;
  /** Reduced motion only: animations still running once the state is reached, as `name duration`. */
  motion?: string[];
  /** Phone only: the smallest control in the sample, in CSS pixels. */
  target?: { width: number; height: number };
}

const controls =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';

/** Waits for every animation that ends (a pending spinner's never does). */
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );

/** Animations longer than a frame that are running now, as `name duration` (`infinite` when they never end). */
const running = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .flatMap((animation) => {
        const timing = animation.effect?.getComputedTiming();
        const duration = Number(timing?.duration ?? 0);
        const name =
          animation instanceof CSSTransition
            ? animation.transitionProperty
            : animation instanceof CSSAnimation
              ? animation.animationName
              : 'script';
        return duration > 16 || timing?.iterations === Infinity
          ? [`${name} ${duration}ms${timing?.iterations === Infinity ? ' infinite' : ''}`]
          : [];
      }),
  );

const smallest = (sample: Locator) =>
  sample.locator(controls).evaluateAll(
    (nodes) =>
      nodes
        .filter((node) => node.checkVisibility())
        .map((node) => {
          const { width, height } = node.getBoundingClientRect();
          return { width: Math.round(width), height: Math.round(height) };
        })
        .sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height))[0],
  );

async function check(page: Page, state: KitState, condition: Condition): Promise<Omit<StateCheck, 'scheme' | 'condition'>> {
  const shown = (drivenStates as readonly string[]).includes(state) ? 'rest' : state;
  const section = `[data-kit-state="${shown}"]`;
  const sample = page.locator(section).locator('[data-kit-sample]');
  const marked = sample.locator('[data-kit-target]');
  const target = (await marked.count()) ? marked.first() : sample.locator(controls).first();
  // In the middle of the window, clear of the frame's fixed bars (a phone's bottom bar would cover a sample
  // that happens to straddle it, and axe would count that as an obscured target).
  await page.locator(section).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  if (state === 'hover') await target.hover();
  if (state === 'focus') {
    // A key both React Aria (which ignores a lone modifier) and the browser's :focus-visible count, then the target.
    await page.keyboard.press('Tab');
    await target.focus();
  }
  if (state === 'pressed') {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  const motion = condition === 'reduced motion' ? await running(page) : undefined;
  await settle(page);
  const axe = await new AxeBuilder({ page })
    .include(section)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const painted = await colours(sample);
  const own = (await target.count()) ? await colours(target) : {};
  const result = {
    state,
    axe: axe.violations.flatMap(({ id, nodes }) => nodes.map(({ target }) => `${id}: ${target.join(' ')}`)),
    text: painted.text?.ratio,
    icon: own.icon?.ratio,
    ring: state === 'focus' ? (own.outline?.ratio ?? 0) : undefined,
    motion,
    target: condition === 'phone' ? await smallest(sample) : undefined,
  };
  if (state === 'pressed') {
    // Released away from the target, so the press is cancelled and nothing is activated.
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
  if (state === 'focus') await target.blur();
  return result;
}

/** Every state `path` shows, plus the driven ones, in light and dark under each condition. */
export async function galleryStates(browser: Browser, baseURL: string, path: string): Promise<StateCheck[]> {
  const checks: StateCheck[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    for (const condition of conditions) {
      const context = await browser.newContext({
        baseURL,
        viewport: condition === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        hasTouch: condition === 'phone',
        colorScheme: scheme,
        forcedColors: condition === 'forced colours' ? 'active' : 'none',
        reducedMotion: condition === 'reduced motion' ? 'reduce' : 'no-preference',
      });
      await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL }]);
      const page = await context.newPage();
      try {
        await gotoHydrated(page, path);
        await page.evaluate(() => document.fonts.ready);
        const shown = await page
          .locator('[data-kit-state]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kit-state')!));
        const states = [...shown, ...(shown.includes('rest') ? drivenStates : [])] as KitState[];
        for (const state of states) checks.push({ scheme, condition, ...(await check(page, state, condition)) });
      } finally {
        await context.close();
      }
    }
  }
  return checks;
}

/**
 * What fails, one line each: an axe violation; text under 4.5:1 or an icon under 3:1 (a disabled state's are exempt,
 * WCAG 1.4.3 and 1.4.11); a focused target without a 3:1 ring; motion left under reduced motion; a phone target
 * under `target` CSS pixels a side (the state matrix's floor is 44; WCAG 2.5.8's is 24).
 */
export function stateProblems(checks: readonly StateCheck[], { target = 44 } = {}): string[] {
  return checks.flatMap((check) => {
    const where = `${check.scheme} ${check.condition} ${check.state}`;
    const problems = check.axe.map((violation) => `${where}: axe ${violation}`);
    if (check.state !== 'disabled' && check.text !== undefined && check.text < 4.5) problems.push(`${where}: text ${check.text}:1`);
    if (check.state !== 'disabled' && check.icon !== undefined && check.icon < 3) problems.push(`${where}: icon ${check.icon}:1`);
    if (check.ring !== undefined && check.ring < 3) problems.push(`${where}: focus ring ${check.ring ? `${check.ring}:1` : 'missing'}`);
    for (const animation of check.motion ?? []) problems.push(`${where}: moves under reduced motion: ${animation}`);
    if (check.target && Math.min(check.target.width, check.target.height) < target)
      problems.push(`${where}: target ${check.target.width}×${check.target.height} px`);
    return problems;
  });
}
