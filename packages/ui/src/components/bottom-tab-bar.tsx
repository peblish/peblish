import type { ReactNode } from 'react';
import { Badge } from './badge.tsx';
import { Link } from './link.tsx';
import { Text } from './text.tsx';

export interface BottomTab {
  /** A stable key. */
  id: string;
  href: string;
  /** The tab's name, shown under its icon. */
  label: string;
  /** Drawn above the label, hidden from assistive technology: the label names the tab. */
  icon: ReactNode;
  /**
   * The page shown is this destination or lies under it, as a feed under Home or a community under
   * Communities: `aria-current="page"`, as Commons marks it (Mux's Link has no `aria-current="true"`).
   */
  current?: boolean;
  /** A count on the icon (the inbox's unread): `shown` as drawn, `spoken` the word read after it. */
  count?: { shown: string; spoken: string };
}

/**
 * The phone's bottom bar (Commons' BottomTabBar): a named `nav` of plain links, so it works before
 * hydration and with scripts off. The current destination is marked by `aria-current`, its colour
 * and a filled indicator behind its icon (an outline and an underline under forced colours), never
 * by colour alone. Each tab is at least a 44px target. Where it shows is the frame's to say.
 */
export function BottomTabBar({ label, tabs, className }: { label: string; tabs: readonly BottomTab[]; className?: string }) {
  return (
    <nav className={['pb-tabbar', className].filter(Boolean).join(' ')} aria-label={label}>
      {tabs.map((tab) => (
        <Link key={tab.id} className="pb-tabbar__tab" href={tab.href} current={tab.current}>
          <span className="pb-tabbar__icon" aria-hidden="true">
            {tab.icon}
          </span>
          <Text className="pb-tabbar__label">{tab.label}</Text>
          {/* After the label, so the tab's name starts with what it shows: "Inbox 3 unread". */}
          {tab.count && (
            <>
              <Badge tone="brand" className="pb-tabbar__count">
                {tab.count.shown}
              </Badge>
              <Text className="pb-sr"> {tab.count.spoken}</Text>
            </>
          )}
        </Link>
      ))}
    </nav>
  );
}
