import { Disclosure, DisclosureGroup, Link } from '@muxui/react';
import type { ComponentPropsWithoutRef, ComponentType, ReactNode } from 'react';

/** What a custom link component receives: spread it onto the router's link. */
export interface LinkedDisclosureLinkProps {
  to: string;
  className: string;
  children: ReactNode;
}

/** Any other `div` attribute (`id`, `data-testid`, `aria-describedby`) goes on the root. */
export interface LinkedDisclosureProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title' | 'children'> {
  /** The trigger's label; also the label of the link that stands in for it without scripts. */
  title: ReactNode;
  /**
   * An address at which the server renders this disclosure open, built by the caller: normally
   * this page with a query parameter, and a fragment naming this disclosure's `id`.
   */
  openHref: string;
  /** Render it open: the caller passes `true` when `openHref`'s parameter is in the address. */
  defaultExpanded?: boolean;
  children?: ReactNode;
  /**
   * The link to render the stand-in with. Left out, it is Mux UI's `Link`, which navigates
   * through the router given to `LocaleProvider`. Pass the app's router link to get its preloading.
   */
  link?: ComponentType<LinkedDisclosureLinkProps>;
}

/** The Disclosure's key in its group; each LinkedDisclosure has a group of its own. */
const key = 'panel';

/**
 * A Mux `Disclosure` that still works with scripts off. A closed Mux Disclosure's panel is zero
 * height and `inert`, and its trigger needs script, so without script a link to `openHref`
 * stands in for it, and the server renders it open there: content readable, links followed,
 * forms posted. Which one shows is CSS only (`@media (scripting: none)` in
 * linked-disclosure.css), so the markup is the same before and after hydration.
 *
 * The Disclosure sits alone in a `DisclosureGroup`, where Mux draws its chevron. The stand-in is
 * outside the group, whose rules count on the Disclosure being its first and last child, so the
 * root is a `div` that holds both and keeps the caller's `id`, class and attributes; `openHref`
 * can carry a fragment to it. (Mux UI rc.7's Disclosure keeps an `id` of its own, but the
 * stand-in still needs a root outside the group.)
 */
export function LinkedDisclosure({
  title,
  openHref,
  defaultExpanded = false,
  children,
  link: As,
  className,
  ...rest
}: LinkedDisclosureProps) {
  const open = 'pb-linked-disclosure__open pb-link-quiet';
  return (
    <div {...rest} className={['pb-linked-disclosure', className].filter(Boolean).join(' ')}>
      {defaultExpanded ? (
        // Rendered open: without script this plain label replaces the trigger, which could not close it.
        <span className="pb-linked-disclosure__label">{title}</span>
      ) : As ? (
        <As to={openHref} className={open}>
          {title}
        </As>
      ) : (
        <Link href={openHref} className={open}>
          {title}
        </Link>
      )}
      <DisclosureGroup defaultExpandedIds={defaultExpanded ? [key] : []}>
        <Disclosure id={key} title={title}>
          {children}
        </Disclosure>
      </DisclosureGroup>
    </div>
  );
}
