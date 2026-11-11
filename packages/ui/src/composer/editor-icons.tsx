import type { ReactNode, SVGProps } from 'react';

// The formatting toolbar's icons, drawn rather than typed: a bold or italic letter would need
// the bold and italic font files on every page with the editor, and an arrow or quote mark
// outside the Latin slices fetches the whole font.

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const BoldIcon = () => (
  <Icon strokeWidth="2">
    <path d="M4.5 2.5h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z" />
  </Icon>
);
export const ItalicIcon = () => (
  <Icon>
    <path d="M6.5 2.5h6M3.5 13.5h6M9.5 2.5l-3 11" />
  </Icon>
);
export const StrikeIcon = () => (
  <Icon>
    <path d="M2.5 8h11M11 4.5C10.5 3.3 9.4 2.5 8 2.5c-1.9 0-3.2 1.1-3.2 2.6 0 .9.4 1.6 1.2 2M5 11.5c.5 1.2 1.6 2 3 2 1.9 0 3.2-1.1 3.2-2.6 0-.5-.1-.9-.4-1.3" />
  </Icon>
);
export const LinkIcon = () => (
  <Icon>
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.8-.8" />
  </Icon>
);
export const QuoteIcon = () => (
  <Icon>
    <path d="M3 3v10M6.5 5h6.5M6.5 8h6.5M6.5 11h4" />
  </Icon>
);
export const CodeIcon = () => (
  <Icon>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </Icon>
);
export const BulletListIcon = () => (
  <Icon>
    <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
    <circle cx="2.75" cy="4" r=".75" fill="currentColor" />
    <circle cx="2.75" cy="8" r=".75" fill="currentColor" />
    <circle cx="2.75" cy="12" r=".75" fill="currentColor" />
  </Icon>
);
export const NumberedListIcon = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.5 2.75 3.5 2v3.5M2.25 9.5c.2-.6.7-1 1.3-1 .6 0 1.1.4 1.1 1 0 .9-2.4 1.6-2.4 3h2.5" />
  </Icon>
);
export const HeadingIcon = () => (
  <Icon>
    <path d="M3.5 2.5v11M12.5 2.5v11M3.5 8h9" />
  </Icon>
);
export const SpoilerIcon = () => (
  <Icon>
    <path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z" />
    <circle cx="8" cy="8" r="1.75" />
    <path d="M2.5 13.5 13.5 2.5" />
  </Icon>
);
