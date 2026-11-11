import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { FactList } from './fact-list.tsx';

test('a dl of label and value pairs in Mux text styles', () => {
  const html = renderToStaticMarkup(
    <FactList
      data-testid="facts"
      items={[
        { label: 'Joined', value: '3 May' },
        { label: 'Posts', value: '12', key: 'posts' },
      ]}
    />,
  );
  expect(html).toMatch(/^<dl data-testid="facts" class="pb-facts pb-facts--rows">/);
  expect(html.match(/<dt>/g)).toHaveLength(2);
  expect(html).toContain('<dt><span class="muxui-text muxui-text--label-sm muxui-text--muted">Joined</span></dt>');
  expect(html).toContain('<dd><div class="muxui-text muxui-text--body-sm">12</div></dd>');
  expect(renderToStaticMarkup(<FactList layout="inline" items={[]} />)).toContain('pb-facts--inline');
});
