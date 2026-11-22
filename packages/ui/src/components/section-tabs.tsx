import { LinkTabs, type LinkTabsProps } from './link-tabs.tsx';

/**
 * A page's section tabs under the frame's view header (Commons; the admin tabs): LinkTabs at the
 * column's gutter, on a rule across the column. On a phone each tab is a 44px target. Real links, so
 * they work before hydration and with scripts off.
 */
export function SectionTabs({ className, ...props }: LinkTabsProps) {
  return <LinkTabs {...props} className={['pb-section-tabs', className].filter(Boolean).join(' ')} />;
}
