import type { ReactNode, Ref } from 'react';
import { FeedSkeleton } from '../skeleton/skeletons.tsx';
import { Button } from './button.tsx';
import type { Density } from './post-row.tsx';
import { Text } from './text.tsx';

/**
 * Where a list that loads by itself stands at its end (Commons' auto-load, the mock's notes/feed.md):
 * `more` waits for the reader to near the end, `pending` loads the next batch, `failed` did not, and
 * `end` has nothing more.
 */
export type FeedEndState = 'more' | 'pending' | 'failed' | 'end';

export interface FeedEndLabels {
  /** "More posts did not load." */
  failed: string;
  retry: string;
  /** "That is everything for now." */
  end: string;
}

export interface FeedEndProps {
  state: FeedEndState;
  /** The skeleton rows of a pending batch take the list's density. */
  density: Density;
  labels: FeedEndLabels;
  onRetry?: () => void;
  /** The element a list's observer watches: rendered in the `more` state only. */
  sentinelRef?: Ref<HTMLDivElement>;
  /** The end itself, a focus target (Retry parks focus on it; Skip lands on it when nothing follows). */
  endRef?: Ref<HTMLDivElement>;
  /** Beside Retry: the real next-page link, which still works when the batch would not load. */
  fallback?: ReactNode;
}

/**
 * The end of a list that loads its next batch by itself: a pending batch's skeleton rows (no status of
 * their own, since the list says once what loaded), the failure line with Retry, the end line, or the
 * sentinel. Nothing in it moves focus; the list does that after a Retry.
 */
export function FeedEnd({ state, density, labels, onRetry, sentinelRef, endRef, fallback }: FeedEndProps) {
  return (
    <div className="pb-feed-end" ref={endRef} tabIndex={-1} data-state={state}>
      {state === 'pending' && <FeedSkeleton density={density} />}
      {state === 'failed' && (
        <div className="pb-feed-end__failed">
          <Text>{labels.failed}</Text>
          <span className="pb-feed-end__actions">
            <Button variant="neutral" onActivate={onRetry}>
              {labels.retry}
            </Button>
            {fallback}
          </span>
        </div>
      )}
      {state === 'end' && (
        <Text as="p" color="muted" className="pb-feed-end__line">
          {labels.end}
        </Text>
      )}
      {state === 'more' && <div ref={sentinelRef} className="pb-feed-end__sentinel" />}
    </div>
  );
}

/**
 * Skip past the posts: endless posts would keep the keyboard from what follows them (the rail, the
 * phone's tab bar), so the list starts with this, out of sight until focused, like a skip link. It
 * needs scripts: a list renders it only once it loads by itself, after hydration.
 */
export function FeedSkip({
  label,
  onSkip,
  disabled,
  shown = false,
}: {
  label: string;
  onSkip: () => void;
  disabled?: boolean;
  /** Drawn as when it has focus, whatever has it (the component gallery). */
  shown?: boolean;
}) {
  return (
    <div className="pb-feed-skip" data-shown={shown || undefined}>
      <Button size="sm" variant="neutral" onActivate={onSkip} disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}
