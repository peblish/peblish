import { Card } from '@peblish/ui/components/card';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';

// Stand-ins for the shared pieces the GW2 lane is adding to packages/ui (`badge`, `notice`,
// `link-tabs`, `fact-list`), with the same props, so each use moves over by changing its import.
// Built only from Mux components; their look is in settings.css. Delete this file once GW2 lands.

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/** A static status mark ("Verified", "On.", "This device", a count). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <Text variant="label" size="sm" className={`settings-mark settings-mark--${tone}`}>
      {children}
    </Text>
  );
}

/** An inline notice: a filled Mux Card with a stripe in the tone's colour. */
export function Notice({
  tone = 'neutral',
  role,
  title,
  children,
  action,
}: {
  tone?: Tone;
  role?: 'alert' | 'status';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card.Root variant="filled" padding="sm" role={role} className={`settings-notice settings-notice--${tone}`}>
      {title != null && (
        <Text as="p" variant="label" size="md">
          {title}
        </Text>
      )}
      {children != null && (
        <Text as="div" size="sm">
          {children}
        </Text>
      )}
      {action}
    </Card.Root>
  );
}

/** Tabs that are pages: a `nav` of Mux Links, the current one marked `aria-current="page"`. */
export function LinkTabs({
  'aria-label': label,
  items,
}: {
  'aria-label': string;
  items: readonly { to: string; label: ReactNode; active?: boolean; key?: string }[];
}) {
  return (
    <nav aria-label={label} className="settings-tabs">
      {items.map((item) => (
        <Link key={item.key ?? item.to} href={item.to} current={item.active} className="settings-tabs__tab">
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** A label and value list, labels as muted Mux label text. */
export function FactList({ items }: { items: readonly { label: ReactNode; value: ReactNode; key?: string }[] }) {
  return (
    <dl className="settings-facts">
      {items.map((item, index) => (
        <div key={item.key ?? index}>
          <dt>
            <Text variant="label" size="sm" color="muted">
              {item.label}
            </Text>
          </dt>
          <dd>
            <Text as="div">{item.value}</Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}
