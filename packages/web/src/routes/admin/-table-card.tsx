import { Card } from '@peblish/ui/components/card';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A staff table in its outlined card. Where the table is wider than the page (a phone, or beside the open
 * sidebar at 1100px) it scrolls inside the card, so the card is a region named like its table, and a
 * keyboard stop while, and only while, it overflows: arrow keys then scroll it. The server renders no stop;
 * the browser measures, and measures again when the card or the table changes size (a row's details shown,
 * the window turned).
 */
export function TableCard({
  label,
  className,
  children,
  ...rest
}: { label: string; className?: string; children: ReactNode } & Record<`data-${string}`, string>) {
  const card = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = card.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollWidth > node.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const table = node.querySelector('.muxui-table');
    if (table) observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <Card.Root
      ref={card}
      variant="outlined"
      padding="sm"
      role="region"
      aria-label={label}
      tabIndex={overflows ? 0 : undefined}
      className={['adm-scroller', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </Card.Root>
  );
}
