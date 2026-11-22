import type { ReactNode } from 'react';
import { Link } from './link.tsx';
import { Text } from './text.tsx';

export interface RailLinkItem {
  href: string;
  label: ReactNode;
  /** A count after the label (a filter's matches), in muted figures. */
  count?: ReactNode;
  /** The place shown: `aria-current="page"` and label weight. */
  current?: boolean;
  /** A stable key; `href` is used without one. */
  key?: string;
}

/**
 * A list of places in a RailPanel (Commons' rail lists): one quiet link per row, its count at the end,
 * the current one marked. Rows are 24px targets beside a page, 44px on a phone. Real links, so every
 * filter works without scripts.
 */
export function RailLinks({ items }: { items: readonly RailLinkItem[] }) {
  return (
    <ul className="pb-rail-links">
      {items.map((item) => (
        <li key={item.key ?? item.href}>
          <Link href={item.href} current={item.current} className="pb-rail-links__link pb-link-quiet">
            <span className="pb-rail-links__label">{item.label}</span>
            {item.count !== undefined && (
              <Text size="sm" color="muted" className="pb-rail-links__count">
                {item.count}
              </Text>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
