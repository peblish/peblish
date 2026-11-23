import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { initialIcon } from './sidebar-communities.tsx';

// A community's row draws the initial the shell's data brings from the server (data.ts), whatever its
// label: a browser whose Unicode data is older would work out another, and the row would not hydrate.
vi.mock('@peblish/ui/components/avatar-initial.ts', () => ({
  avatarInitial: () => {
    throw new Error('the browser works out no initial');
  },
}));

test("a community's row draws the server's initial as it is", () => {
  for (const initial of ['\u{1F1E6}\u{1F1FA}', '각', 'Aࢗ']) {
    const html = renderToStaticMarkup(createElement(initialIcon(initial)));
    expect(html).toContain(`>${initial}</`);
  }
});
