import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { LinkTabs, type LinkTabLinkProps } from './link-tabs.tsx';

const items = [
  { to: '/admin', label: 'Reports', active: true },
  { to: '/admin/bans', label: 'Bans' },
];

test('a labelled nav of Mux links with the tab classes, the active one marked current', () => {
  const html = renderToStaticMarkup(<LinkTabs aria-label="Admin" items={items} />);
  expect(html).toMatch(/^<nav aria-label="Admin" class="muxui-tabs pb-link-tabs">/);
  expect(html).toContain('data-muxui-tabs-variant="underline"');
  const links = html.match(/<a [^>]*>/g) ?? [];
  expect(links).toHaveLength(2);
  expect(links[0]).toContain('href="/admin"');
  expect(links[0]).toContain('class="muxui-link muxui-tabs__tab"');
  expect(links[0]).toContain('aria-current="page"');
  expect(links[1]).not.toContain('aria-current');
});

test('a custom link component gets to, the tab class and aria-current', () => {
  const RouterLink = ({ to, children, ...rest }: LinkTabLinkProps) => (
    <a data-router="" href={to} {...rest}>
      {children}
    </a>
  );
  const html = renderToStaticMarkup(<LinkTabs aria-label="Sort" variant="segment" items={items} link={RouterLink} />);
  expect(html).toContain('data-muxui-tabs-variant="segment"');
  expect(html).toContain('<a data-router="" href="/admin" class="muxui-tabs__tab" aria-current="page">Reports</a>');
  expect(html).toContain('<a data-router="" href="/admin/bans" class="muxui-tabs__tab">Bans</a>');
});

test('native attributes reach the nav, and the name stays the one given', () => {
  const html = renderToStaticMarkup(
    <LinkTabs aria-label="Admin" id="tabs" data-testid="admin-tabs" aria-describedby="note" items={items} />,
  );
  expect(html).toMatch(
    /^<nav id="tabs" data-testid="admin-tabs" aria-describedby="note" aria-label="Admin" class="muxui-tabs pb-link-tabs">/,
  );
});
