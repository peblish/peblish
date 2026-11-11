import { Text } from '@muxui/react';
import type { TextSize } from '@muxui/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** Any other `blockquote` attribute (`cite`, `aria-hidden`, `data-hidden`) goes on the root. */
export interface QuoteProps extends ComponentPropsWithoutRef<'blockquote'> {
  children: ReactNode;
  /** Draws a line down the quote's start edge. */
  edge?: boolean;
  size?: TextSize;
}

/**
 * Someone else's words, quoted. Mux `Text` cannot render a `blockquote`, so this keeps the element
 * for its meaning and puts the words in `Text`.
 */
export function Quote({ children, edge = false, size, className, ...rest }: QuoteProps) {
  return (
    <blockquote {...rest} className={['pb-quote', className].filter(Boolean).join(' ')} data-edge={edge || undefined}>
      <Text as="p" size={size} className="pb-quote__text">
        {children}
      </Text>
    </blockquote>
  );
}
