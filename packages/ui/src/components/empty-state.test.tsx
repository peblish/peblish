import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { EmptyState } from './empty-state.tsx';

test('a Mux title heading, a muted line and the action', () => {
  const html = renderToStaticMarkup(
    <EmptyState title="Nothing here yet" action={<a href="/communities">Find communities</a>}>
      Join a community to fill your feed.
    </EmptyState>,
  );
  expect(html).toContain('<h2 class="muxui-text muxui-text--title-sm">Nothing here yet</h2>');
  expect(html).toContain('muxui-text--muted">Join a community to fill your feed.</p>');
  expect(html).toContain('<div class="pb-empty-state__action"><a href="/communities">Find communities</a></div>');
});

test('the heading level follows the outline and the optional parts stay out', () => {
  const html = renderToStaticMarkup(<EmptyState title="No replies" level={3} />);
  expect(html).toContain('<h3 class="muxui-text muxui-text--title-sm">No replies</h3>');
  expect(html).not.toContain('<p');
  expect(html).not.toContain('pb-empty-state__action');
});

test('native attributes reach the root div', () => {
  const html = renderToStaticMarkup(
    <EmptyState title="Nothing here" id="e" data-testid="empty" aria-describedby="note" className="extra" />,
  );
  expect(html).toMatch(/^<div id="e" data-testid="empty" aria-describedby="note" class="pb-empty-state extra">/);
});
