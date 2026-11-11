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

/** The focus ring's colours, inner then outer: Mux's two box-shadows, or the stylesheet's two outlines. */
export const ringColours = (indicator: Locator) =>
  indicator.evaluate((element) => {
    const shadows = getComputedStyle(element).boxShadow.match(/rgba?\([^)]*\)/g);
    if (shadows) return shadows;
    return [getComputedStyle(element, '::before').outlineColor, getComputedStyle(element).outlineColor];
  });

/** The computed paint of every Mux radio and checkbox on the page: what native-state.css could change. */
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

/** Deletes native-state.css's rules from the page's stylesheets; returns how many it deleted. */
export function removeNativeStateRules(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ours = /__button(:not\(\[data-muxui-state-(selected|focused)\]\)|\[data-muxui-state-selected\]):has\(input:/;
    let removed = 0;
    const sweep = (list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) => {
      for (let index = list.length - 1; index >= 0; index--) {
        const rule = list[index];
        if (rule instanceof CSSStyleRule && ours.test(rule.selectorText)) {
          owner.deleteRule(index);
          removed++;
        } else if (rule instanceof CSSGroupingRule) sweep(rule.cssRules, rule);
      }
    };
    for (const sheet of document.styleSheets) sweep(sheet.cssRules, sheet);
    return removed;
  });
}
