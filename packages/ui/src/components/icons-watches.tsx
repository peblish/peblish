import { Bell, BellRing, type LucideProps } from 'lucide-react';

// Glyphs added by the thread follows (lane f-notify), re-exported from icons.tsx as one group, drawn as its icons are.

type IconProps = Omit<LucideProps, 'ref'>;

/** Follow thread: the bell, and the ringing bell once the thread is followed (its shape, not only its colour, says so). */
export const BellIcon = (props: IconProps) => <Bell size="1em" focusable="false" {...props} />;
export const BellRingIcon = (props: IconProps) => <BellRing size="1em" focusable="false" {...props} />;
