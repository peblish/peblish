import { useId, type ReactNode } from 'react';
import { Text } from './text.tsx';

export interface RailPanelProps {
  /** The panel's heading, which names it. Without one the panel is a plain block. */
  title?: ReactNode;
  /** The heading's level: 2 (the default) beside a page's h1. */
  headingLevel?: 2 | 3;
  /** Beside the title: a count, or one link or button ("See all"). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * One block of the right rail: a flat panel (a faint edge on a quiet fill, no shadow) with an
 * optional heading and action, its content spaced by Mux's group gap. Not a Mux Card: a rail block
 * is not raised. Titled, it is a `section` named by its heading.
 */
export function RailPanel({ title, headingLevel = 2, action, children, className }: RailPanelProps) {
  const titleId = useId();
  return (
    <section className={['pb-panel', className].filter(Boolean).join(' ')} aria-labelledby={title ? titleId : undefined}>
      {(title || action) && (
        <div className="pb-panel__head">
          {title && (
            <Text as={`h${headingLevel}`} id={titleId} variant="label" size="sm" className="pb-panel__title">
              {title}
            </Text>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
