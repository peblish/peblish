import type { ReactNode } from 'react';

export interface ViewHeaderProps {
  /** The start of the bar: Back, or on a phone the site's mark and the finder. */
  leading?: ReactNode;
  /** The page's name, centred whatever the two sides hold. */
  title?: ReactNode;
  /** What a phone's bar shows in the title's place (the mock's feed switcher, say); the title otherwise. */
  phoneTitle?: ReactNode;
  /** The page's own actions at the end of the bar (a sort menu, Mark all read). */
  trailing?: ReactNode;
  /**
   * The title is left out (no room, nothing for assistive technology), for a page whose own heading
   * is still in view, so its name never shows twice; it shows once that heading has scrolled under.
   */
  quiet?: boolean;
  className?: string;
}

/**
 * The centre column's bar (Commons' ViewHeader): leading, title and trailing on one row, on the
 * page's surface with a hairline under it. On a phone it is the top bar and its controls are 44px
 * targets. Where it sticks is the frame's to say (packages/web/src/shell/shell.css); this is the bar
 * alone, with no landmark of its own.
 */
export function ViewHeader({ leading, title, phoneTitle, trailing, quiet = false, className }: ViewHeaderProps) {
  return (
    <div className={['pb-vh', className].filter(Boolean).join(' ')}>
      <div className="pb-vh__leading">{leading}</div>
      <div className="pb-vh__title" data-quiet={quiet || undefined} aria-hidden={quiet || undefined}>
        {phoneTitle ? (
          <>
            <span className="pb-vh__title-desktop">{title}</span>
            <span className="pb-vh__title-phone">{phoneTitle}</span>
          </>
        ) : (
          title
        )}
      </div>
      <div className="pb-vh__trailing">{trailing}</div>
    </div>
  );
}
