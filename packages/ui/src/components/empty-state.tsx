import { Text } from '@muxui/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** Any other `div` attribute (`id`, `data-testid`, `aria-describedby`) goes on the root `div`. */
export interface EmptyStateProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title' | 'children'> {
  title: ReactNode;
  /** One line saying why it is empty or what to do. */
  children?: ReactNode;
  /** One facade `Button` or `Link`, or a few side by side. */
  action?: ReactNode;
  /** The heading level in the page outline (1 when the state is the whole page); it does not change the look. */
  level?: 1 | 2 | 3;
}

/** Nothing to show yet: a Mux title, a muted line and an optional action, centred in the column. */
export function EmptyState({ title, children, action, level = 2, className, ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className={['pb-empty-state', className].filter(Boolean).join(' ')}>
      <Text as={`h${level}`} variant="title" size="sm">
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
