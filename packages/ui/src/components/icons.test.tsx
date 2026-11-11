import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ArrowUp, HouseIcon, PlusIcon } from './icons.tsx';

test('an icon is a 1em Lucide glyph in currentColor, hidden from assistive technology', () => {
  const html = renderToStaticMarkup(<PlusIcon />);
  expect(html).toMatch(/^<svg [^>]*width="1em" height="1em"[^>]*stroke="currentColor"[^>]*class="lucide lucide-plus"/);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('focusable="false"');
});

test('a named icon is not hidden, and props win over the defaults', () => {
  const html = renderToStaticMarkup(<HouseIcon aria-label="Home" className="pb-nav-icon" strokeWidth={1.5} />);
  expect(html).not.toContain('aria-hidden');
  expect(html).toContain('aria-label="Home"');
  expect(html).toContain('class="lucide lucide-house pb-nav-icon"');
  expect(html).toContain('stroke-width="1.5"');
});

test('the vote arrows are filled', () => {
  expect(renderToStaticMarkup(<ArrowUp />)).toContain('fill="currentColor"');
  expect(renderToStaticMarkup(<ArrowUp fill="none" />)).toContain('fill="none"');
});
