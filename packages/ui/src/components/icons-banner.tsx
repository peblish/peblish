import { CalendarDays, Megaphone, Sparkles, TriangleAlert, Wrench, type LucideProps } from 'lucide-react';

// Glyphs added by the site banner lane (site-banner.tsx), re-exported from icons.tsx as one group, drawn as its icons are.

type IconProps = Omit<LucideProps, 'ref'>;

export const MegaphoneIcon = (props: IconProps) => <Megaphone size="1em" focusable="false" {...props} />;
export const WrenchIcon = (props: IconProps) => <Wrench size="1em" focusable="false" {...props} />;
export const CalendarIcon = (props: IconProps) => <CalendarDays size="1em" focusable="false" {...props} />;
export const AlertIcon = (props: IconProps) => <TriangleAlert size="1em" focusable="false" {...props} />;
export const SparklesIcon = (props: IconProps) => <Sparkles size="1em" focusable="false" {...props} />;
