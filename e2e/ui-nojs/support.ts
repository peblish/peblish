import type { Browser, Locator, Page } from '@playwright/test';

/**
 * A part as drawn, transitions finished, in a square around its centre: by default one that takes in
 * the focus ring (4px past the box), with a negative `margin` only what is inside its edge. The same
 * size for every part of a kind, wherever it sits on the pixel grid.
 */
export async function shot(part: Locator, margin = 5): Promise<Buffer> {
  // The clip is in viewport coordinates.
  await part.scrollIntoViewIfNeeded();
  const box = await part.boundingBox();
  if (!box) throw new Error('the part is not drawn');
  const size = Math.ceil(Math.max(box.width, box.height)) + 2 * margin;
  const x = Math.round(box.x + box.width / 2 - size / 2);
  const y = Math.round(box.y + box.height / 2 - size / 2);
  return part.page().screenshot({ animations: 'disabled', clip: { x, y, width: size, height: size } });
}

/**
 * The share of pixels that differ (any channel by more than 16 of 255) between two PNGs, compared in
 * a page of its own with JavaScript on, so it works for pages that have it off. 1 when the sizes differ.
 */
export async function pixelDiff(browser: Browser, a: Buffer, b: Buffer): Promise<number> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(
      async ([first, second]) => {
        const decode = async (base64: string) => {
          const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no 2d canvas');
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height);
        };
        const [x, y] = await Promise.all([decode(first), decode(second)]);
        if (x.width !== y.width || x.height !== y.height) return 1;
        let differing = 0;
        for (let pixel = 0; pixel < x.data.length; pixel += 4) {
          for (let channel = 0; channel < 4; channel++) {
            if (Math.abs((x.data[pixel + channel] ?? 0) - (y.data[pixel + channel] ?? 0)) > 16) {
              differing++;
              break;
            }
          }
        }
        return differing / (x.width * x.height);
      },
      [a.toString('base64'), b.toString('base64')] as const,
    );
  } finally {
    await context.close();
  }
}

/** The focus ring's colours, inner then outer, from Mux's two box-shadows; none when no ring shows. */
export const ringColours = (indicator: Locator) =>
  indicator.evaluate((element) => getComputedStyle(element).boxShadow.match(/rgba?\([^)]*\)/g) ?? []);

/** The computed paint of every Mux radio and checkbox on the page: what the rules that draw from the input could change. */
export function drawing(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.muxui-radio-field__button, .muxui-checkbox-field__button')].map((button) => {
      const pick = (element: Element | null, pseudo: string | null, names: string[]) => {
        if (!element) return null;
        const style = getComputedStyle(element, pseudo);
        return names.map((name) => style.getPropertyValue(name));
      };
      const indicator = button.querySelector('.muxui-radio-field__indicator, .muxui-checkbox-field__indicator');
      return {
        indicator: pick(indicator, null, ['position', 'border-color', 'background-color', 'box-shadow', 'outline-style', 'outline-color']),
        before: pick(indicator, '::before', ['content', 'border-color']),
        after: pick(indicator, '::after', ['content', 'width', 'background-color', 'mask-image']),
        icon: pick(button.querySelector('svg'), null, ['visibility']),
        dot: pick(button.querySelector('.muxui-radio-field__dot'), null, ['display', 'opacity', 'transform']),
        motionDot: pick(button.querySelector('.muxui-radio-group__motion-dot'), null, ['display', 'background-color', 'width']),
      };
    }),
  );
}

/** The kinds of control Mux's before-hydration rules draw, as `removeInputStateRules` counts them. */
export type InputStateFamily = 'checkbox background' | 'checkbox tick' | 'radio' | 'switch';

/**
 * Deletes Mux's rules that draw a choice control from its native input while React's state attribute
 * is stale: a compound selector that tests a `data-muxui-state-selected`, `-indeterminate` or
 * `-focused` attribute and `:has(input:...)` together. Returns how many it deleted, in all and per
 * family (a rule may count for more than one), so a caller can tell every family was found.
 */
export function removeInputStateRules(page: Page): Promise<{ removed: number; families: Record<InputStateFamily, number> }> {
  return page.evaluate(() => {
    /** `text` cut at each top-level `separator` (outside brackets, parentheses and quotes). */
    const split = (text: string, separator: (char: string) => boolean) => {
      const parts: string[] = [];
      let depth = 0;
      let quote = '';
      let start = 0;
      for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (quote) {
          if (char === '\\') index++;
          else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if (depth === 0 && separator(char)) {
          parts.push(text.slice(start, index));
          start = index + 1;
        }
      }
      parts.push(text.slice(start));
      return parts.map((part) => part.trim()).filter(Boolean);
    };
    const stale = (compound: string) =>
      /\[data-muxui-state-(selected|indeterminate|focused)\]/.test(compound) && compound.includes(':has(input:');
    // A selector list's complex selectors, then each one's compounds (cut at descendant and other combinators).
    const isStale = (selectorText: string) =>
      split(selectorText, (char) => char === ',').some((complex) => split(complex, (char) => /[\s>+~]/.test(char)).some(stale));

    const families: Record<InputStateFamily, number> = { 'checkbox background': 0, 'checkbox tick': 0, radio: 0, switch: 0 };
    let removed = 0;
    const count = (rule: CSSStyleRule) => {
      const selector = rule.selectorText;
      if (/checkbox/.test(selector) && /::after|\bsvg\b/.test(selector)) families['checkbox tick']++;
      else if (/checkbox/.test(selector) && rule.style.backgroundColor) families['checkbox background']++;
      if (/muxui-radio/.test(selector)) families.radio++;
      if (/muxui-switch/.test(selector)) families.switch++;
    };
    const sweep = (list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) => {
      for (let index = list.length - 1; index >= 0; index--) {
        const rule = list[index];
        if (rule instanceof CSSStyleRule && isStale(rule.selectorText)) {
          count(rule);
          owner.deleteRule(index);
          removed++;
        } else if (rule instanceof CSSGroupingRule) sweep(rule.cssRules, rule);
      }
    };
    for (const sheet of document.styleSheets) sweep(sheet.cssRules, sheet);
    return { removed, families };
  });
}
