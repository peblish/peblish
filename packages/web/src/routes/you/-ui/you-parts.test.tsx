import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { YouIdentity } from './you-parts.tsx';

// A name that begins with an emoji: its initial must be the whole emoji. Half of it (one UTF-16 unit)
// is a lone surrogate, which the server sends as U+FFFD while the client keeps it, so hydration fails.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("the You page's avatar shows a leading emoji whole", () => {
  const html = renderToStaticMarkup(<YouIdentity name={'\u{1F33F} Fern'} handle="fern" />);
  expect(html).not.toMatch(loneSurrogate);
  expect(html).toContain('>\u{1F33F}</');
});
