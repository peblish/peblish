import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { LoadMore, Pager } from './pager.tsx';

test('a labelled nav with first, previous and next links and their rel', () => {
  const html = renderToStaticMarkup(
    <Pager
      aria-label="More posts"
      first={{ href: '/', label: 'Newest' }}
      previous={{ href: '/?page=1', label: 'Previous' }}
      next={{ href: '/?page=3', label: 'Next' }}
    >
      21 to 40
    </Pager>,
  );
  expect(html).toMatch(/^<nav aria-label="More posts" class="pb-pager">/);
  expect(html).toContain('muxui-text--muted">21 to 40</span>');
  expect(html).toMatch(/<a class="muxui-link"[^>]* href="\/"[^>]*>Newest<\/a>/);
  expect(html).toMatch(/href="\/\?page=1" rel="prev"[^>]*>Previous</);
  expect(html).toMatch(/href="\/\?page=3" rel="next"[^>]*>Next</);
});

test('nothing renders without links or a line', () => {
  expect(renderToStaticMarkup(<Pager aria-label="More posts" />)).toBe('');
});

test('load more is a neutral Mux button that can be pending', () => {
  const html = renderToStaticMarkup(<LoadMore pending>Load more</LoadMore>);
  expect(html).toContain('class="muxui-button"');
  expect(html).toContain('data-muxui-variant="neutral"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('>Load more</span>');
});

test('native attributes reach the nav', () => {
  const html = renderToStaticMarkup(
    <Pager aria-label="More posts" id="p" data-testid="pager" aria-describedby="note" next={{ href: '/?page=2', label: 'Next' }} />,
  );
  expect(html).toMatch(/^<nav id="p" data-testid="pager" aria-describedby="note" aria-label="More posts" class="pb-pager">/);
});
