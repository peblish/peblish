import {
  ArrowBigDown,
  ArrowBigUp,
  Bold,
  Check,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  CircleHelp,
  ClipboardList,
  Code,
  Compass,
  Ellipsis,
  ExternalLink,
  EyeOff,
  FileText,
  Flame,
  Globe,
  HeartHandshake,
  Heading,
  House,
  Image,
  Inbox,
  Info,
  Italic,
  Link,
  List,
  ListOrdered,
  Lock,
  MessageSquare,
  LogIn,
  MapPin,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Share,
  Shield,
  ShieldCheck,
  SquarePen,
  Strikethrough,
  Text,
  TextQuote,
  UserPlus,
  UserRound,
  Users,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import type { BrandPack } from '../brand/pack.ts';

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

// The Commons frame (packages/web/src/shell): Create post, Back, the sidebar's fold, the moderation
// queue, the site's own pages, the account's pages in the phone drawer and the current appearance in
// the account menu.
export const SquarePenIcon = icon(SquarePen);
export const UserRoundIcon = icon(UserRound);
export const SettingsIcon = icon(Settings);
export const ChevronLeft = icon(LucideChevronLeft);
export const PanelLeftCloseIcon = icon(PanelLeftClose);
export const PanelLeftOpenIcon = icon(PanelLeftOpen);
export const ClipboardListIcon = icon(ClipboardList);
export const InfoIcon = icon(Info);
export const HeartHandshakeIcon = icon(HeartHandshake);
export const LockIcon = icon(Lock);
export const FileTextIcon = icon(FileText);
/** The site's pages, as one menu at the foot of the folded sidebar. */
export const CircleHelpIcon = icon(CircleHelp);
/** A row's own actions (a sidebar row's options). */
export const EllipsisIcon = icon(Ellipsis);
export const CheckIcon = icon(Check);

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

// The shared post pieces (post-row, vote-control, link-preview, nsfw-cover). The vote arrows here
// are outlined; vote-control.css fills the one that is cast, so a vote never shows by colour alone.
export const VoteUpIcon = icon(ArrowBigUp);
export const VoteDownIcon = icon(ArrowBigDown);
export const CommentsIcon = icon(MessageSquare);
export const ShareIcon = icon(Share);
export const ExternalLinkIcon = icon(ExternalLink);
export const CoverIcon = icon(EyeOff);

/** A brand pack's mark (brand/pack.ts): its one path in currentColor, always hidden (the link around it is named). */
export function MarkIcon({ mark, className }: { mark: BrandPack['mark']; className?: string }) {
  return (
    <svg className={className} viewBox={mark.viewBox} aria-hidden="true" focusable="false">
      <path d={mark.d} transform={mark.transform} fill="currentColor" />
    </svg>
  );
}
