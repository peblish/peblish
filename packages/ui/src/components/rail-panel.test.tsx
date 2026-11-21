import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { RailPanel } from './rail-panel.tsx';

test('a titled panel is a section named by its heading, with the action beside it', () => {
  const html = renderToStaticMarkup(
    <RailPanel title="About" headingLevel={3} action={<a href="/c/art/about">All</a>}>
      <p>Charcoal and ink.</p>
    </RailPanel>,
  );
  const id = /<section class="pb-panel" aria-labelledby="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeTruthy();
  expect(html).toMatch(new RegExp(`<h3 class="[^"]*pb-panel__title[^"]*" id="${id}"`));
  expect(html).toContain('<a href="/c/art/about">All</a></div><p>');
  expect(renderToStaticMarkup(<RailPanel>x</RailPanel>)).toBe('<section class="pb-panel">x</section>');
});
