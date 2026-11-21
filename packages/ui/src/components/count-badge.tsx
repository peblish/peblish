import { Badge } from '@muxui/react';

export interface CountBadgeProps {
  count: number;
  /** Counts above it show as "<max>+": 99 by default. */
  max?: number;
  locale: string;
  /**
   * The count's name for assistive technology ("3 unread"), read in place of the number. Without it
   * the badge is hidden from assistive technology, and the control it sits in says the count in its
   * own name.
   */
  label?: string;
  className?: string;
}

/**
 * A small count on a control (Inbox's unread notices): Mux UI's solid brand Badge, drawn as Commons'
 * pill (count-badge.css). Nothing renders for zero.
 */
export function CountBadge({ count, max = 99, locale, label, className }: CountBadgeProps) {
  if (count <= 0) return null;
  const format = new Intl.NumberFormat(locale);
  const shown = count > max ? `${format.format(max)}+` : format.format(count);
  return (
    <Badge
      tone="brand"
      variant="solid"
      className={['pb-count', className].filter(Boolean).join(' ')}
      {...(label ? { label } : { 'aria-hidden': true })}
    >
      {shown}
    </Badge>
  );
}
