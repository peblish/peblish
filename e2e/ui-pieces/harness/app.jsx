// The harness page for LinkedDisclosure and ButtonLink (e2e/ui-pieces/linked-pieces.spec.ts).
// Plain JSX, not TSX: the root tsconfig checks e2e/ without JSX settings or React's types,
// and Vite (build.mjs) compiles this file with the packages it imports.
import { useEffect } from 'react';
import { ButtonLink } from '../../../packages/ui/src/components/button-link.tsx';
import { Button } from '../../../packages/ui/src/components/button.tsx';
import { DisclosureGroup } from '../../../packages/ui/src/components/disclosure-group.tsx';
import { Disclosure } from '../../../packages/ui/src/components/disclosure.tsx';
import { LinkedDisclosure } from '../../../packages/ui/src/components/linked-disclosure.tsx';
import { Link } from '../../../packages/ui/src/components/link.tsx';
import { TextField } from '../../../packages/ui/src/components/text-field.tsx';
import { LocaleProvider } from '../../../packages/ui/src/locale.tsx';

export const longTitle = 'Ban from !community@a-very-long-host-name-for-a-community-server.example';
export const variants = ['primary', 'neutral', 'ghost'];
export const sizes = ['md', 'sm'];

/** What Mod tools hold on the community page: links, and a form that posts. */
function Tools() {
  return (
    <>
      <ul className="hx-links">
        <li>
          <Link href="/reports">Reports</Link>
        </li>
      </ul>
      <form method="post" action="/save" className="hx-form">
        <TextField name="note" label="Note" />
        <Button type="submit" name="intent" value="save">
          Save
        </Button>
      </form>
    </>
  );
}

/** `search` is the request's query string; the server and the client read the same one. */
export function App({ search }) {
  const query = new URLSearchParams(search);
  const tools = query.has('tools');
  const ban = query.has('ban');
  useEffect(() => {
    document.documentElement.dataset.hydrated = '1';
  }, []);
  return (
    <LocaleProvider locale="en-US">
      <main className="hx-page">
        <div className="hx-column" data-testid="linked">
          <LinkedDisclosure id="mod-tools" title="Mod tools" openHref="/?tools=1#mod-tools" defaultExpanded={tools}>
            <Tools />
          </LinkedDisclosure>
        </div>
        {/* A plain Mux Disclosure in a group, as Mux documents it: what LinkedDisclosure must look like with scripts on. */}
        <div className="hx-column" data-testid="reference">
          <DisclosureGroup defaultExpandedIds={tools ? ['ref'] : []}>
            <Disclosure id="ref" title="Mod tools">
              <Tools />
            </Disclosure>
          </DisclosureGroup>
        </div>
        <div className="hx-column" data-testid="long">
          <LinkedDisclosure id="ban" title={longTitle} openHref="/?ban=1#ban" defaultExpanded={ban}>
            <p>Ban form</p>
          </LinkedDisclosure>
        </div>
        <div className="hx-buttons">
          {variants.flatMap((variant) =>
            sizes.map((size) => (
              <div className="hx-pair" key={`${variant}-${size}`} data-pair={`${variant}-${size}`}>
                <Button variant={variant} size={size} data-testid="button">
                  Create post
                </Button>
                <ButtonLink href="/submit" variant={variant} size={size} data-testid="link">
                  Create post
                </ButtonLink>
              </div>
            )),
          )}
        </div>
      </main>
    </LocaleProvider>
  );
}
