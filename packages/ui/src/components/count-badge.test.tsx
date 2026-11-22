import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { CountBadge } from './count-badge.tsx';

test('the count in the locale on a solid brand Badge, capped at max, hidden unless named, and nothing for zero', () => {
  const hidden = renderToStaticMarkup(<CountBadge count={3} locale="en-US" />);
  expect(hidden).toMatch(/^<span [^>]*aria-hidden="true"/);
  expect(hidden).toContain('class="muxui-badge pb-count"');
  expect(hidden).toContain('data-muxui-tone="brand"');
  expect(hidden).toContain('data-muxui-variant="solid"');
  expect(hidden).toContain('>3</span>');
  expect(renderToStaticMarkup(<CountBadge count={1500} max={999} locale="de-DE" />)).toContain('>999+<');
  // Named, the number is hidden and the name is read in its place.
  const named = renderToStaticMarkup(<CountBadge count={3} locale="en-US" label="3 unread" />);
  expect(named).not.toMatch(/^<span [^>]*aria-hidden/);
  expect(named).toContain('<span class="muxui-badge__text" aria-hidden="true">3</span>');
  expect(named).toContain('<span class="muxui-badge__label">3 unread</span>');
  expect(renderToStaticMarkup(<CountBadge count={0} locale="en-US" />)).toBe('');
});
