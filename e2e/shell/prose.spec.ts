import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';

// The rendered-content styles and Prose's behaviour on what the server pipeline emits. The
// gallery renders its bodies on the server (kit/-render.ts), so this is the real path.
test.beforeEach(({ request }) => skipWithoutKit(request));

test('the gallery shows output of the Markdown renderer and the sanitiser, not hand-written markup', async ({ request }) => {
  const html = await (await request.get('/kit')).text();
  // Only the sanitiser adds these.
  expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  expect(html).toContain('class="hljs-keyword"');
  expect(html).toContain('class="footnotes-sep"');
  expect(html).toContain('<span class="spoiler">hidden spoiler</span>');
});
