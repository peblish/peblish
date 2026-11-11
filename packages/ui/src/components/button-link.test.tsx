import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ButtonLink, type ButtonLinkLinkProps } from './button-link.tsx';
import { Button } from './button.tsx';

/** The opening tag of the first element, its attributes as a set (order is React's business). */
const attributes = (html: string) => new Set(/^<\w+ ([^>]*)>/.exec(html)?.[1]?.match(/[\w-]+="[^"]*"/g));

test('a Mux link with Mux Button’s class, variant, size and label wrapper', () => {
  const html = renderToString(<ButtonLink href="/submit">Create post</ButtonLink>);
  expect(html).toMatch(/^<a /);
  const own = attributes(html);
  expect(own).toContain('href="/submit"');
  expect(own).toContain('class="muxui-link muxui-button pb-button-link"');
  expect(own).toContain('data-muxui-variant="primary"');
  expect(own).toContain('data-muxui-size="md"');
  expect(html).toContain('<span class="muxui-button__label">Create post</span></a>');
  // The same attributes Mux's Button puts on its button, which its stylesheet keys on.
  const button = attributes(renderToString(<Button>Create post</Button>));
  for (const name of ['data-muxui-variant="primary"', 'data-muxui-size="md"']) expect(button).toContain(name);
});

test('variant, size, aria-current and native attributes reach the link', () => {
  const html = renderToString(
    <ButtonLink href="/auth/sign-up" variant="ghost" size="sm" aria-current="page" id="up" target="_blank" rel="noopener" data-testid="cta">
      Sign up
    </ButtonLink>,
  );
  const own = attributes(html);
  for (const name of [
    'data-muxui-variant="ghost"',
    'data-muxui-size="sm"',
    'aria-current="page"',
    'id="up"',
    'target="_blank"',
    'rel="noopener"',
    'data-testid="cta"',
  ])
    expect(own).toContain(name);
  expect(attributes(renderToString(<ButtonLink href="/x">X</ButtonLink>))).not.toContain('aria-current="page"');
});

test('a custom link component gets to, the classes, the state attributes and the rest', () => {
  const RouterLink = ({ to, children, ...rest }: ButtonLinkLinkProps) => (
    <a data-router="" href={to} {...rest}>
      {children}
    </a>
  );
  const html = renderToString(
    <ButtonLink link={RouterLink} href="/submit" variant="neutral" size="sm" aria-current="page" className="pb-create" id="create">
      Create post
    </ButtonLink>,
  );
  expect(html).toBe(
    '<a data-router="" href="/submit" id="create" class="muxui-button pb-button-link pb-create" aria-current="page" data-muxui-variant="neutral" data-muxui-size="sm"><span class="muxui-button__label">Create post</span></a>',
  );
});
