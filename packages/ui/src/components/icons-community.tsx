import { Hourglass, LayoutGrid, type LucideProps } from 'lucide-react';

// Glyphs added by the community-directory lane, re-exported from icons.tsx as one group, drawn as its icons are.

type IconProps = Omit<LucideProps, 'ref'>;

export const HourglassIcon = (props: IconProps) => <Hourglass size="1em" focusable="false" {...props} />;
export const LayoutGridIcon = (props: IconProps) => <LayoutGrid size="1em" focusable="false" {...props} />;
