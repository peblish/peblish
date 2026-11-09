import type { SVGProps } from 'react';

// Small inline icons. Drawn here rather than typed as characters: a glyph outside the Latin
// font slices (the vote triangles, arrows) makes the browser fetch the 876 kB full Inter file.

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
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

type IconProps = SVGProps<SVGSVGElement>;

/** A filled triangle: the vote arrows. */
export const ArrowUp = (props: IconProps) => (
  <Icon fill="currentColor" stroke="none" {...props}>
    <path d="M8 3 14 12H2z" />
  </Icon>
);
export const ArrowDown = (props: IconProps) => (
  <Icon fill="currentColor" stroke="none" {...props}>
    <path d="M8 13 2 4h12z" />
  </Icon>
);
export const TextIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
  </Icon>
);
export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.8-.8" />
  </Icon>
);
export const ImageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <circle cx="6" cy="7" r="1" />
    <path d="m3 12 3.5-3.5L9 11l2-2 3 3" />
  </Icon>
);
export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </Icon>
);
export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const ChevronRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 3 5 5-5 5" />
  </Icon>
);
export const ChevronDown = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3 6 5 5 5-5" />
  </Icon>
);
