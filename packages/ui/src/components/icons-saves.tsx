import { Bookmark, type LucideProps } from 'lucide-react';

// The glyph added by the saves lane (Save and Unsave, the Saved page and its navigation entry), re-exported
// from icons.tsx as one group, drawn as its icons are.

type IconProps = Omit<LucideProps, 'ref'>;

export const BookmarkIcon = (props: IconProps) => <Bookmark size="1em" focusable="false" {...props} />;
