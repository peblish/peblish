import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { YouIdentity } from './you-parts.tsx';

// The initial is the server's (ShellData.initial): the page draws it as it is and works none out, so no
// browser's own Unicode data can make it differ from the server's page.
vi.mock('@peblish/ui/components/avatar-initial.ts', () => ({
  avatarInitial: () => {
    throw new Error('the browser works out no initial');
  },
}));

test("the You page's avatar draws the server's initial as it is", () => {
  const html = renderToStaticMarkup(<YouIdentity name={'각 Jun'} initial={'각'} handle="jun" />);
  expect(html).toContain('>각</');
});
