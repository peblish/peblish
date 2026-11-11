import { Button, Link, Text } from '@muxui/react';
import type { ButtonProps } from '@muxui/react';
import type { ReactNode } from 'react';

export interface PagerLink {
  href: string;
  label: ReactNode;
}

export interface PagerProps {
  /** Names the `nav` landmark, for example "More posts". */
  'aria-label': string;
  /** Back to the start of the list (the newest page). */
  first?: PagerLink;
  /** The page before, as `rel="prev"`. */
  previous?: PagerLink;
  /** The page after, as `rel="next"`. */
  next?: PagerLink;
  /** A line before the links, such as "21 to 40 of 312". */
  children?: ReactNode;
  className?: string;
}

/**
 * Previous and next page links under a list, as Mux `Link`s in a `nav`. Plain links, so paging works
 * with scripts off. Renders nothing when there is no link and no line.
 */
export function Pager({ 'aria-label': label, first, previous, next, children, className }: PagerProps) {
  if (!first && !previous && !next && children == null) return null;
  return (
    <nav aria-label={label} className={['pb-pager', className].filter(Boolean).join(' ')}>
      {children != null && (
        <Text size="sm" color="muted">
          {children}
        </Text>
      )}
      {first && <Link href={first.href}>{first.label}</Link>}
      {previous && (
        <Link href={previous.href} rel="prev">
          {previous.label}
        </Link>
      )}
      {next && (
        <Link href={next.href} rel="next">
          {next.label}
        </Link>
      )}
    </nav>
  );
}

export type LoadMoreProps = Pick<ButtonProps, 'onActivate' | 'pending' | 'disabled' | 'className'> & {
  children: ReactNode;
};

/** "Load more" at the end of a list that grows in place: a neutral Mux `Button` that shows `pending`. */
export function LoadMore({ children, className, ...rest }: LoadMoreProps) {
  return (
    <div className={['pb-pager', className].filter(Boolean).join(' ')}>
      <Button {...rest} variant="neutral">
        {children}
      </Button>
    </div>
  );
}
