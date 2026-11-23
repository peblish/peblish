import { ChevronUp, Pin, type LucideProps } from 'lucide-react';

// Glyphs added by the pins lane, re-exported from icons.tsx as one group, drawn as its icons are.

type IconProps = Omit<LucideProps, 'ref'>;

/** Pin; a pinned one is drawn filled by its control's style. */
export const PinIcon = (props: IconProps) => <Pin size="1em" focusable="false" {...props} />;
/** Move up, beside ChevronDown for Move down. */
export const ChevronUpIcon = (props: IconProps) => <ChevronUp size="1em" focusable="false" {...props} />;
