import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Notice } from './notice.tsx';

test('a notice is a filled Mux card with its tone, role, title, body and action', () => {
  const html = renderToStaticMarkup(
    <Notice tone="danger" role="alert" title="Could not save" action={<a href="/retry">Retry</a>}>
      The name is taken.
    </Notice>,
  );
  expect(html).toMatch(/^<div role="alert" class="muxui-card muxui-card--filled[^"]* pb-alert pb-alert--danger">/);
  expect(html).toContain('pb-alert__title">Could not save</p>');
  expect(html).toContain('pb-alert__body">The name is taken.</div>');
  expect(html).toContain('<a href="/retry">Retry</a>');
});

test('without a role or title it is a plain neutral block', () => {
  const html = renderToStaticMarkup(<Notice>Saved.</Notice>);
  expect(html).not.toContain('role=');
  expect(html).toContain('pb-alert--neutral');
  expect(html).not.toContain('pb-alert__title');
  expect(
    renderToStaticMarkup(
      <Notice tone="success" role="status">
        Saved.
      </Notice>,
    ),
  ).toContain('role="status"');
});

test('native attributes reach the card', () => {
  const html = renderToStaticMarkup(
    <Notice id="n" data-testid="notice" aria-describedby="note">
      Saved.
    </Notice>,
  );
  expect(html).toMatch(/^<div id="n" data-testid="notice" aria-describedby="note" class="muxui-card[^"]* pb-alert pb-alert--neutral">/);
});

test('a heading level renders the title as that heading, with the same look', () => {
  const html = renderToStaticMarkup(
    <Notice tone="warning" title="Check your email" level={2}>
      We sent a link.
    </Notice>,
  );
  expect(html).toContain('<h2 class="muxui-text muxui-text--label-md pb-alert__title">Check your email</h2>');
  expect(html).not.toContain('<p');
  expect(renderToStaticMarkup(<Notice title="Note" level={4} />)).toContain(
    '<h4 class="muxui-text muxui-text--label-md pb-alert__title">Note</h4>',
  );
});
