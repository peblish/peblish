import {
  ArrowBigDown,
  ArrowBigUp,
  Bold,
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  Code,
  Compass,
  EyeOff,
  Flame,
  Globe,
  Heading,
  House,
  Image,
  Inbox,
  Italic,
  Link,
  List,
  ListOrdered,
  LogIn,
  MapPin,
  Menu,
  Network,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Strikethrough,
  Text,
  TextQuote,
  UserPlus,
  Users,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

// Icons from Lucide, the set Mux UI draws its own with, imported by name so the bundle keeps
// only these. Drawn as SVG rather than typed as characters: a glyph outside the Latin font
// slices (the vote triangles, arrows) makes the browser fetch the 876 kB full Inter file.

export type IconProps = Omit<LucideProps, 'ref'>;

/**
 * One icon: 1em square (so it follows the text or the CSS around it, as Mux's Sidebar does with
 * its icon class), stroked in currentColor, and hidden from assistive technology unless the
 * caller names it (Lucide adds aria-hidden when no aria-* prop, role or title is given). `defaults` are props the glyph always starts from, such as a fill.
 */
function icon(Glyph: LucideIcon, defaults: IconProps = {}) {
  const Icon = (props: IconProps) => <Glyph size="1em" focusable="false" {...defaults} {...props} />;
  Icon.displayName = Glyph.displayName;
  return Icon;
}

/** The vote arrows, filled: the colour says whether the vote is cast. Also the move up and down buttons. */
export const ArrowUp = icon(ArrowBigUp, { fill: 'currentColor' });
export const ArrowDown = icon(ArrowBigDown, { fill: 'currentColor' });
export const TextIcon = icon(Text);
export const LinkIcon = icon(Link);
export const ImageIcon = icon(Image);
export const MenuIcon = icon(Menu);
export const CloseIcon = icon(X);
export const PlusIcon = icon(Plus);
export const ChevronRight = icon(LucideChevronRight);
export const ChevronDown = icon(LucideChevronDown);

// The sidebar's navigation (shell/sidebar.tsx, mock direction A where it shows one). Each fits
// Sidebar.NavItem's `icon` slot, which passes a class name and sizes it.
export const HouseIcon = icon(House);
export const MapPinIcon = icon(MapPin);
export const GlobeIcon = icon(Globe);
export const FlameIcon = icon(Flame);
export const ShieldIcon = icon(Shield);
export const InboxIcon = icon(Inbox);
export const ShieldCheckIcon = icon(ShieldCheck);
export const UsersIcon = icon(Users);
export const NetworkIcon = icon(Network);
export const CompassIcon = icon(Compass);
export const SearchIcon = icon(Search);

// The phone bar's signed-out actions when they collapse to icons (shell/account.tsx).
export const LogInIcon = icon(LogIn);
export const UserPlusIcon = icon(UserPlus);

// The Markdown editor's formatting toolbar (composer/markdown-editor.tsx); its links reuse LinkIcon.
export const BoldIcon = icon(Bold);
export const ItalicIcon = icon(Italic);
export const StrikethroughIcon = icon(Strikethrough);
export const QuoteIcon = icon(TextQuote);
export const CodeIcon = icon(Code);
export const BulletListIcon = icon(List);
export const NumberedListIcon = icon(ListOrdered);
export const HeadingIcon = icon(Heading);
export const SpoilerIcon = icon(EyeOff);
