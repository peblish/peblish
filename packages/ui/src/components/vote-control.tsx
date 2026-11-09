import { useState } from 'react';
import { ArrowDown, ArrowUp } from './icons.tsx';

export type Vote = -1 | 0 | 1;

export interface VoteControlLabels {
  /** The group's name for assistive technology: "Vote". */
  group: string;
  up: string;
  down: string;
}

export interface VoteControlProps {
  /** The score as the server counted it, including the viewer's own vote. */
  score: number;
  myVote: Vote;
  /**
   * Called with the vote the viewer now holds: 1 or -1, or 0 when they take their vote back by
   * pressing the same arrow again. The score and arrows change at once; if the returned
   * promise rejects they go back to what they were.
   */
  onVote?: (value: Vote) => void | Promise<void>;
  /** The arrows cannot be used (signed out, locked); they stay visible but inert. */
  disabled?: boolean;
  orientation?: 'vertical' | 'horizontal';
  labels: VoteControlLabels;
  locale: string;
  className?: string;
}

/**
 * Up and down arrows with the score between them: two plain buttons, not a Mux collection, so
 * the first tap right after hydration is not lost (e2e/hydration). Optimistic: the viewer's
 * choice shows before `onVote` settles.
 */
export function VoteControl({ score, myVote, onVote, disabled, orientation = 'vertical', labels, locale, className }: VoteControlProps) {
  const [state, setState] = useState({ base: myVote, vote: myVote });
  // A new value from the server replaces the optimistic one (derived state, set while rendering).
  if (state.base !== myVote) setState({ base: myVote, vote: myVote });

  async function cast(value: 1 | -1) {
    const previous = state.vote;
    const next: Vote = previous === value ? 0 : value;
    setState({ base: myVote, vote: next });
    try {
      await onVote?.(next);
    } catch {
      setState({ base: myVote, vote: previous });
    }
  }

  const shown = score - myVote + state.vote;
  const classes = ['pb-vote', orientation === 'horizontal' && 'pb-vote--row', className].filter(Boolean).join(' ');
  return (
    <div className={classes} role="group" aria-label={labels.group}>
      <button
        type="button"
        className="pb-vote__up"
        aria-label={labels.up}
        aria-pressed={state.vote === 1}
        disabled={disabled}
        onClick={() => cast(1)}
      >
        <ArrowUp />
      </button>
      <span className="pb-vote__score">{new Intl.NumberFormat(locale).format(shown)}</span>
      <button
        type="button"
        className="pb-vote__down"
        aria-label={labels.down}
        aria-pressed={state.vote === -1}
        disabled={disabled}
        onClick={() => cast(-1)}
      >
        <ArrowDown />
      </button>
    </div>
  );
}
