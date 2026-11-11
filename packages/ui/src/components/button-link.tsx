import { Link, type LinkProps } from '@muxui/react';
import type { ComponentType, ReactNode } from 'react';

/** The Button variants the app puts on a link. */
export type ButtonLinkVariant = 'primary' | 'neutral' | 'ghost';
export type ButtonLinkSize = 'md' | 'sm';

/** Anchor attributes, as Mux's `Link` takes them; `disabled` and `onActivate` are Mux Link's own and left out. */
type Native = Omit<LinkProps, 'href' | 'current' | 'disabled' | 'onActivate' | 'children' | 'className' | 'aria-current'>;

/** What a custom link component receives: spread it onto the router's link. */
export interface ButtonLinkLinkProps extends Native {
  to: string;
  className: string;
  'aria-current'?: 'page';
  'data-muxui-variant': ButtonLinkVariant;
  'data-muxui-size': ButtonLinkSize;
  children: ReactNode;
}

/** Any other attribute (`id`, `target`, `rel`, `aria-label`, `data-testid`) goes on the `a`. */
export interface ButtonLinkProps extends Native {
  href: string;
  /** Mux Button's variant; default `primary`. */
  variant?: ButtonLinkVariant;
  /** Mux Button's size; default `md`. */
  size?: ButtonLinkSize;
  /** The page this link leads to is the one shown. */
  'aria-current'?: 'page';
  className?: string;
  children: ReactNode;
  /**
   * The link to render. Left out, it is Mux UI's `Link`, which navigates through the router given
   * to `LocaleProvider`. Pass the app's router link (receiving `to`) to get its preloading, or an
   * `a` of your own when a click must do something else.
   */
  link?: ComponentType<ButtonLinkLinkProps>;
}

/**
 * A real link that looks exactly like a Mux `Button`. Mux's stylesheet already styles
 * `.muxui-link.muxui-button` as a button (its link rules skip `.muxui-button`), so this puts
 * Button's class and variant and size attributes on a Mux `Link`, and the look follows Mux.
 * button-link.css only undoes the app's base `a` rules and puts back the outline Mux's link
 * rule removes. It stays a link: role link, followed without script, opens in a new tab on a
 * modified click.
 */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  'aria-current': current,
  className,
  children,
  link: As,
  ...rest
}: ButtonLinkProps) {
  const classes = ['muxui-button', 'pb-button-link', className].filter(Boolean).join(' ');
  // The label wrapper Mux's Button renders, so an icon and the text share its gap and centring.
  const label = <span className="muxui-button__label">{children}</span>;
  return As ? (
    <As {...rest} to={href} className={classes} aria-current={current} data-muxui-variant={variant} data-muxui-size={size}>
      {label}
    </As>
  ) : (
    <Link {...rest} href={href} current={current === 'page'} className={classes} data-muxui-variant={variant} data-muxui-size={size}>
      {label}
    </Link>
  );
}
