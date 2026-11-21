export interface CountBadgeProps {
  count: number;
  /** Counts above it show as "<max>+": 99 by default. */
  max?: number;
  locale: string;
  /**
   * The count's name for assistive technology ("3 unread"). Without it the badge is hidden from
   * assistive technology, and the control it sits in says the count in its own name.
   */
  label?: string;
  className?: string;
}

/**
 * A small count on a control (Inbox's unread notices): a brand pill with the number. Nothing
 * renders for zero. Mux UI's passive Badge arrives with the next candidate; until then this is
 * drawn from Mux tokens.
 */
export function CountBadge({ count, max = 99, locale, label, className }: CountBadgeProps) {
  if (count <= 0) return null;
  const format = new Intl.NumberFormat(locale);
  const shown = count > max ? `${format.format(max)}+` : format.format(count);
  return (
    <span
      className={['pb-count', className].filter(Boolean).join(' ')}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {shown}
    </span>
  );
}
