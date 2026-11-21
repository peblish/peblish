import { useEffect, useRef, type ReactNode } from 'react';
import { useHydrated } from '../composer/use-hydrated.ts';
import { Button } from './button.tsx';
import { CoverIcon } from './icons.tsx';
import { Text } from './text.tsx';

export interface NsfwCoverLabels {
  /** What the cover says: "NSFW content hidden". */
  hidden: string;
  /** The reveal button: "Show". */
  show: string;
}

export interface NsfwCoverProps {
  /** Whether the concealed content shows. The cover is controlled: the page decides, with the viewer's eligibility. */
  revealed: boolean;
  /** Show was pressed. The page reveals (sets `revealed`), asks first, or refuses. */
  onReveal: () => void;
  /**
   * The viewer may reveal this content (eligibility is the page's: the age declaration and the
   * community's gate). When false, Show stays visible but disabled.
   */
  eligible: boolean;
  /** A reveal is in flight (a confirmation or a saved choice): Show shows Mux's pending state. */
  pending?: boolean;
  /** `slot` fills a media block (a picture, a link line); `thumb` fits a small thumbnail beside the text. */
  size?: 'slot' | 'thumb';
  labels: NsfwCoverLabels;
  /** The concealed content. It is not rendered until revealed, so neither its picture loads nor its controls are reachable. */
  children: ReactNode;
  className?: string;
}

/**
 * A covered slot in place of sensitive media, never a blurred picture: a glyph, what is hidden,
 * and a named Show button. Until revealed the content is not in the page at all, so it is out of
 * the tab order and the accessibility tree. When it is revealed after the page loaded, focus moves
 * to the content (so the next Tab continues there); when it is covered again, to Show.
 */
export function NsfwCover({ revealed, onReveal, eligible, pending, size = 'slot', labels, children, className }: NsfwCoverProps) {
  const hydrated = useHydrated();
  const content = useRef<HTMLDivElement>(null);
  const show = useRef<HTMLButtonElement>(null);
  const before = useRef(revealed);
  useEffect(() => {
    if (before.current === revealed) return;
    before.current = revealed;
    (revealed ? content.current : show.current)?.focus();
  }, [revealed]);

  if (revealed)
    return (
      <div ref={content} tabIndex={-1} className={['pb-cover-revealed', className].filter(Boolean).join(' ')}>
        {children}
      </div>
    );
  return (
    <div className={['pb-cover', className].filter(Boolean).join(' ')} data-size={size}>
      <CoverIcon />
      <Text size="sm" color="muted" className="pb-cover__text">
        {labels.hidden}
      </Text>
      <Button ref={show} variant="neutral" size="sm" disabled={!eligible || !hydrated} pending={pending} onActivate={onReveal}>
        {labels.show}
      </Button>
    </div>
  );
}
