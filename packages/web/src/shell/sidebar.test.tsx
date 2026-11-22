import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { initialIcon } from './sidebar.tsx';

// A community's row in the sidebar draws its initial; a display name from another server can begin with a
// flag or an emoji, and half of one (a code point of a flag, a UTF-16 unit of an emoji) would not hydrate.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("a community's initial in the sidebar is the label's whole first grapheme", () => {
  for (const [label, initial] of [
    ['\u{1F1E6}\u{1F1FA} Mates', '\u{1F1E6}\u{1F1FA}'],
    ['\u{1F33F} Ferns', '\u{1F33F}'],
    ['élan', 'É'],
  ]) {
    const html = renderToStaticMarkup(createElement(initialIcon(label!)));
    expect(html).not.toMatch(loneSurrogate);
    expect(html).toContain(`>${initial}</`);
  }
});
