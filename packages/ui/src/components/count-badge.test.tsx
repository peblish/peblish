import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { CountBadge } from './count-badge.tsx';

test('the count in the locale, capped at max, hidden unless named, and nothing for zero', () => {
  expect(renderToStaticMarkup(<CountBadge count={3} locale="en-US" />)).toBe('<span class="pb-count" aria-hidden="true">3</span>');
  expect(renderToStaticMarkup(<CountBadge count={1500} max={999} locale="de-DE" />)).toContain('>999+<');
  expect(renderToStaticMarkup(<CountBadge count={3} locale="en-US" label="3 unread" />)).toBe(
    '<span class="pb-count" role="img" aria-label="3 unread">3</span>',
  );
  expect(renderToStaticMarkup(<CountBadge count={0} locale="en-US" />)).toBe('');
});
