import type { Locator } from '@playwright/test';

/** A colour as the browser paints it, 0 to 255 per sRGB channel. */
export type Rgb = [number, number, number];

/** A colour painted over what is behind it, and their WCAG contrast ratio (rounded to 0.01). */
export interface Pair {
  fore: Rgb;
  back: Rgb;
  ratio: number;
}

/**
 * What an element paints, each against what is behind it: its own text colour (`color`, whether or not it holds
 * text), its text (the lowest of its text nodes), its icons (each svg's stroke or fill), its own fill, its edge (its
 * borders, the lowest of the sides it paints, or else an outline drawn inside it or an inset ring) and the ring around it (an outline outside it, or
 * else the widest solid box-shadow ring), such as a focus ring. Absent where it paints none.
 */
export interface Colours {
  color?: Pair;
  text?: Pair;
  /** A field's placeholder, against the field. */
  placeholder?: Pair;
  icon?: Pair;
  fill?: Pair;
  border?: Pair;
  outline?: Pair;
}

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** The WCAG contrast ratio of two colours, rounded to 0.01. */
export function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
}

type Painted = [Rgb, Rgb][];

/**
 * Runs in the page. Each colour is composited in a 1 px canvas over what the element's ancestors paint, from
 * white, so alpha and any CSS colour syntax resolve as the browser paints them; an element with opacity below 1
 * paints itself and what it holds as one group at that opacity (a disabled control). Only ancestors are seen, and
 * the one layer Mux paints beside them (a ToggleButtonGroup's chosen fill, under its label copies): a background
 * image, or any other element positioned over another that is not its ancestor, is not.
 */
function paintedColours(element: Element) {
  const layer = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.getContext('2d', { willReadFrequently: true })!;
  };
  const fill = (context: CanvasRenderingContext2D, colour: string) => {
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
  };
  const ancestry = (node: Element) => {
    const chain: Element[] = [];
    for (let at: Element | null = node; at; at = at.parentElement) chain.unshift(at);
    // Mux's single-choice ToggleButtonGroup paints the chosen button's fill on a layer beside the buttons and draws
    // that button's label again over it: what is behind a copy is that layer, which is not its ancestor.
    const copies = node.closest('.muxui-toggle-button-group__motion-foreground');
    const fill = copies?.parentElement?.querySelector(':scope > .muxui-toggle-button-group__motion-indicator');
    if (copies && fill) chain.splice(chain.indexOf(copies), 0, fill);
    return chain;
  };
  // The backgrounds of chain[0..to), then `top`.
  const pixel = (chain: Element[], to: number, top?: string): [number, number, number] => {
    const paint = (context: CanvasRenderingContext2D, from: number) => {
      for (let index = from; index < to; index++) {
        const style = getComputedStyle(chain[index]!);
        const opacity = Number(style.opacity);
        if (opacity < 1) {
          const group = layer();
          fill(group, style.backgroundColor);
          paint(group, index + 1);
          context.globalAlpha = opacity;
          context.drawImage(group.canvas, 0, 0);
          context.globalAlpha = 1;
          return;
        }
        fill(context, style.backgroundColor);
      }
      if (top) fill(context, top);
    };
    const context = layer();
    fill(context, 'white');
    paint(context, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!];
  };
  // Whether a colour, in any syntax, paints anything: it changes white or black.
  const visible = (colour: string) =>
    ['white', 'black'].some((under) => {
      const context = layer();
      fill(context, under);
      const before = context.getImageData(0, 0, 1, 1).data.join();
      fill(context, colour);
      return context.getImageData(0, 0, 1, 1).data.join() !== before;
    });
  // `colour` drawn by `node` (inside its opacity group), against what is behind it.
  const over = (node: Element, colour: string, own = false): [[number, number, number], [number, number, number]] => {
    const chain = ancestry(node);
    return [pixel(chain, chain.length, colour), pixel(chain, own ? chain.length : chain.length - 1)];
  };
  const text: [[number, number, number], [number, number, number]][] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent?.checkVisibility({ visibilityProperty: true })) continue;
    text.push(over(parent, getComputedStyle(parent).color, true));
  }
  const icon = [...(element instanceof SVGSVGElement ? [element] : element.querySelectorAll('svg'))]
    .filter((svg) => svg.checkVisibility({ visibilityProperty: true }))
    .map((svg) => {
      const style = getComputedStyle(svg.querySelector('path, circle, rect, line, polyline, polygon') ?? svg);
      return over(svg, style.stroke !== 'none' ? style.stroke : style.fill !== 'none' ? style.fill : style.color, true);
    });
  const style = getComputedStyle(element);
  const own = (colour: string | undefined) => (colour && visible(colour) ? [over(element, colour)] : []);
  // Solid rings drawn with box-shadow (no offset or blur, a spread), outward or inset; the widest of each.
  const shadows: { colour: string; spread: number; inset: boolean }[] = [];
  let depth = 0;
  let part = '';
  for (const char of `${style.boxShadow},`) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (char !== ',' || depth > 0) {
      part += char;
      continue;
    }
    const shadow = /^(.+?)\s+0px\s+0px\s+0px\s+([\d.]+)px(\s+inset)?$/.exec(part.trim());
    if (shadow && Number(shadow[2]) > 0 && visible(shadow[1]!))
      shadows.push({ colour: shadow[1]!, spread: Number(shadow[2]), inset: !!shadow[3] });
    part = '';
  }
  const widest = (inset: boolean) => shadows.filter((shadow) => shadow.inset === inset).sort((a, b) => b.spread - a.spread)[0]?.colour;
  const outlined = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0 && visible(style.outlineColor);
  // An outline drawn inside the box (a negative offset) is the control's edge; one outside it, a ring.
  const inside = outlined && Number.parseFloat(style.outlineOffset) < 0;
  // Every side that paints a border (a row's rule is often its bottom one alone), the lowest of them counted.
  const sides = (['Top', 'Right', 'Bottom', 'Left'] as const)
    .filter((side) => Number.parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none')
    .map((side) => style[`border${side}Color`])
    .filter(visible);
  return {
    color: [over(element, style.color, true)],
    text,
    placeholder: element.hasAttribute('placeholder') ? [over(element, getComputedStyle(element, '::placeholder').color, true)] : [],
    icon,
    fill: own(style.backgroundColor),
    border: sides.length ? sides.flatMap((colour) => own(colour)) : own(inside ? style.outlineColor : widest(true)),
    outline: own(outlined && !inside ? style.outlineColor : widest(false)),
  } satisfies Record<keyof Colours, Painted>;
}

/** The pair with the lowest contrast, if any. */
const lowest = (pairs: Painted): Pair | undefined =>
  pairs.map(([fore, back]) => ({ fore, back, ratio: ratio(fore, back) })).sort((a, b) => a.ratio - b.ratio)[0];

/** What `target` paints, each colour against what is behind it (see Colours). */
export async function colours(target: Locator): Promise<Colours> {
  const painted = await target.evaluate(paintedColours);
  return Object.fromEntries(
    Object.entries(painted).flatMap(([kind, pairs]) => {
      const pair = lowest(pairs);
      return pair ? [[kind, pair]] : [];
    }),
  );
}

/** The contrast of `target`'s own text colour (its `color`, whether or not it holds text) against what is behind it. */
export async function contrast(target: Locator): Promise<number> {
  return (await colours(target)).color!.ratio;
}
