import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { LinkedDisclosure, type LinkedDisclosureLinkProps } from './linked-disclosure.tsx';

const href = '/c/rust?tools=1#mod-tools';
const tools = (expanded: boolean) =>
  renderToString(
    <LinkedDisclosure id="mod-tools" title="Mod tools" openHref={href} defaultExpanded={expanded}>
      <a href="/c/rust/reports">Reports</a>
    </LinkedDisclosure>,
  );

test('closed: a Mux link to openHref with the title stands in before a grouped Mux Disclosure', () => {
  const html = tools(false);
  expect(html).toMatch(
    /^<div id="mod-tools" class="pb-linked-disclosure"><a class="muxui-link pb-linked-disclosure__open pb-link-quiet"[^>]* href="\/c\/rust\?tools=1#mod-tools"[^>]*>Mod tools<\/a><div class="muxui-disclosure-group"/,
  );
  // The group is what draws the chevron, and the panel stays closed and inert.
  expect(html).toContain('class="muxui-disclosure__header"><button');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('muxui-disclosure__trigger-icon');
  expect(html).toContain('inert=""');
  expect(html).not.toContain('pb-linked-disclosure__label');
});

test('open: the panel renders open with its content, a plain label in place of the link', () => {
  const html = tools(true);
  expect(html).toContain('<span class="pb-linked-disclosure__label">Mod tools</span>');
  expect(html).not.toContain('pb-linked-disclosure__open');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('data-muxui-state-expanded="true"');
  expect(html).not.toContain('inert');
  expect(html).toContain('<a href="/c/rust/reports">Reports</a>');
});

test('a custom link component gets to, the stand-in class and the title', () => {
  const RouterLink = ({ to, children, ...rest }: LinkedDisclosureLinkProps) => (
    <a data-router="" href={to} {...rest}>
      {children}
    </a>
  );
  const html = renderToString(
    <LinkedDisclosure title="Edit" openHref="/post/1/comments/2?edit=1" link={RouterLink}>
      form
    </LinkedDisclosure>,
  );
  expect(html).toContain('<a data-router="" href="/post/1/comments/2?edit=1" class="pb-linked-disclosure__open pb-link-quiet">Edit</a>');
});

test('native attributes and the class reach the root', () => {
  const html = renderToString(
    <LinkedDisclosure id="edit" data-testid="edit" aria-describedby="note" className="th-own__edit" title="Edit" openHref="?edit=1#edit">
      form
    </LinkedDisclosure>,
  );
  expect(html).toMatch(/^<div id="edit" data-testid="edit" aria-describedby="note" class="pb-linked-disclosure th-own__edit">/);
});
