import { Link } from '@muxui/react';
import type { ComponentPropsWithoutRef, ComponentType, ReactNode } from 'react';

export interface LinkTabItem {
  /** The tab's address: a path, with its query when the tab is a filter. */
  to: string;
  label: ReactNode;
  /** The page this tab names is the one shown; it gets `aria-current="page"`. */
  active?: boolean;
  /** A stable key when `to` repeats. */
  key?: string;
}

/** What a custom link component receives: spread it onto the router's link. */
export interface LinkTabLinkProps {
  to: string;
  className: string;
  'aria-current'?: 'page';
  children: ReactNode;
}

/** Any other `nav` attribute (`id`, `data-testid`, `aria-describedby`) goes on the `nav`. */
export interface LinkTabsProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'aria-label' | 'children'> {
  /** Names the `nav` landmark, for example "Admin" or "Sort". */
  'aria-label': string;
  items: readonly LinkTabItem[];
  /** `underline` for page sections, `segment` for a compact filter or sort switch. */
  variant?: 'underline' | 'segment';
  size?: 'sm' | 'md' | 'lg';
  /**
   * The link to render each tab with. Left out, it is Mux UI's `Link`, which navigates through the
   * router given to `LocaleProvider`. Pass the app's router link to get its preloading.
   */
  link?: ComponentType<LinkTabLinkProps>;
}

/**
 * Tabs that are pages: a `nav` of real links with Mux Tabs' classes and tokens, so it reads like a
 * Mux `Tabs` bar but works before hydration and with scripts off, and each tab can open in a new tab.
 * Mux `Tabs` in rc.7 are buttons (no `href`), so they are only for panels on one page.
 */
export function LinkTabs({ 'aria-label': label, items, variant = 'underline', size, link: As, className, ...rest }: LinkTabsProps) {
  return (
    <nav
      {...rest}
      aria-label={label}
      className={['muxui-tabs', 'pb-link-tabs', className].filter(Boolean).join(' ')}
      data-muxui-size={size}
    >
      <div className="muxui-tabs__motion" data-muxui-tabs-variant={variant}>
        <div className="muxui-tabs__list">
          {items.map((item) => {
            const current: 'page' | undefined = item.active ? 'page' : undefined;
            return As ? (
              <As key={item.key ?? item.to} to={item.to} className="muxui-tabs__tab" aria-current={current}>
                {item.label}
              </As>
            ) : (
              <Link key={item.key ?? item.to} href={item.to} current={item.active} className="muxui-tabs__tab">
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
