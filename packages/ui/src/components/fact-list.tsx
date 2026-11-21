import { Text } from '@muxui/react';
import type { HTMLAttributes, ReactNode } from 'react';

export interface Fact {
  label: ReactNode;
  value: ReactNode;
  /** A stable key; the position is used without one. */
  key?: string;
}

export interface FactListProps extends Omit<HTMLAttributes<HTMLDListElement>, 'children'> {
  items: readonly Fact[];
  /**
   * `rows` puts each label beside its value in two columns (admin details); `inline` sets the pairs
   * side by side, label above value (profile and community stats).
   */
  layout?: 'rows' | 'inline';
  /** `xs` sets labels and values a step smaller, as a rail panel's facts are. */
  size?: 'sm' | 'xs';
}

/** A label and value list (`dl`), labels as muted Mux label text and values as Mux body text. */
export function FactList({ items, layout = 'rows', size = 'sm', className, ...rest }: FactListProps) {
  return (
    <dl {...rest} className={['pb-facts', `pb-facts--${layout}`, className].filter(Boolean).join(' ')}>
      {items.map((item, index) => (
        <div key={item.key ?? index} className="pb-facts__item">
          <dt>
            <Text variant="label" size={size} color="muted">
              {item.label}
            </Text>
          </dt>
          <dd>
            <Text as="div" size={size}>
              {item.value}
            </Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}
