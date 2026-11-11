import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Prose } from './prose.tsx';

test("the footnote back link's arrow becomes one the Latin font slice holds, and only there", () => {
  const html = renderToStaticMarkup(
    <Prose html={'<p>Text ↩ stays.</p><ol><li><p>Note <a href="#fnref1" class="footnote-backref">↩︎</a></p></li></ol>'} />,
  );
  expect(html).toContain('<a href="#fnref1" class="footnote-backref">↑</a>');
  expect(html).toContain('Text ↩ stays.');
});
