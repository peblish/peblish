import { Card, Text } from '@muxui/react';
import type { HTMLAttributes, ReactNode } from 'react';

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role' | 'children'> {
  tone?: NoticeTone;
  /**
   * `alert` for an error or warning that must be heard now, `status` for a result such as "Saved".
   * Leave it unset for a notice that is part of the page from the start.
   */
  role?: 'alert' | 'status';
  /** A short bold first line. */
  title?: ReactNode;
  /** The body: a sentence or two, or inline content. */
  children?: ReactNode;
  /** A link or button (from the facade) shown under the body. */
  action?: ReactNode;
}

/**
 * An inline alert: a filled Mux Card with a status stripe at its start edge. Mux UI's `Message` is a
 * chat bubble and its Toast is transient, so this is the catalogue's composition for page notices.
 */
export function Notice({ tone = 'neutral', role, title, children, action, className, ...rest }: NoticeProps) {
  return (
    <Card.Root
      {...rest}
      variant="filled"
      padding="sm"
      role={role}
      className={['pb-alert', `pb-alert--${tone}`, className].filter(Boolean).join(' ')}
    >
      {title != null && (
        <Text as="p" variant="label" size="md" className="pb-alert__title">
          {title}
        </Text>
      )}
      {children != null && (
        <Text as="div" size="sm" className="pb-alert__body">
          {children}
        </Text>
      )}
      {action != null && <div className="pb-alert__action">{action}</div>}
    </Card.Root>
  );
}
