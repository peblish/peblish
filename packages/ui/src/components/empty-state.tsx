import { Text } from '@muxui/react';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  /** One line saying why it is empty or what to do. */
  children?: ReactNode;
  /** One facade `Button` or `Link`, or a few side by side. */
  action?: ReactNode;
  /** The heading level in the page outline; it does not change the look. */
  level?: 2 | 3;
  className?: string;
}

/** Nothing to show yet: a Mux title, a muted line and an optional action, centred in the column. */
export function EmptyState({ title, children, action, level = 2, className }: EmptyStateProps) {
  return (
    <div className={['pb-empty-state', className].filter(Boolean).join(' ')}>
      <Text as={level === 3 ? 'h3' : 'h2'} variant="title" size="sm">
        {title}
      </Text>
      {children != null && (
        <Text as="p" color="muted">
          {children}
        </Text>
      )}
      {action != null && <div className="pb-empty-state__action">{action}</div>}
    </div>
  );
}
