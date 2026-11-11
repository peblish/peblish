import { useEffect, useState } from 'react';
import { Group } from './group.tsx';
import { ArrowDown, ArrowUp } from './icons.tsx';
import { Text } from './text.tsx';
import { ToggleButton } from './toggle-button-group.tsx';
import { createVoteQueue, type Vote } from './vote-queue.ts';

export type { Vote };

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
   * pressing the same arrow again. The score and arrows change at once. Calls never overlap:
   * a choice made while one is pending waits, and only the newest is sent after it settles. If
   * the returned promise rejects, the arrows go back to the last vote the server accepted.
   */
  onVote?: (value: Vote) => void | Promise<void>;
  /** The arrows cannot be used (signed out, locked); they stay visible but inert. */
  disabled?: boolean;
  orientation?: 'vertical' | 'horizontal';
  labels: VoteControlLabels;
  /** The group's name when it should say what the vote is on ("Vote on <title>"); `labels.group` otherwise. */
  label?: string;
  locale: string;
  className?: string;
}

/**
 * Up and down arrows with the score between them: a Mux UI Group of two ToggleButtons (pressed
 * state, `aria-pressed`) and the score in Mux Text. Not a ToggleButtonGroup: its single selection
 * is a radio group, and a vote must be removable. Optimistic: the viewer's choice shows before
 * `onVote` settles. The voted arrow and score take the --pb-up and --pb-down accents.
 */
export function VoteControl({
  score,
  myVote,
  onVote,
  disabled,
  orientation = 'vertical',
  labels,
  label,
  locale,
  className,
}: VoteControlProps) {
  const [state, setState] = useState({ base: myVote, vote: myVote });
  // A new value from the server replaces the optimistic one (derived state, set while rendering).
  if (state.base !== myVote) setState({ base: myVote, vote: myVote });

  const save = (value: Vote) => onVote?.(value);
  const [queue] = useState(() => createVoteQueue({ initial: myVote, onChange: (vote) => setState((current) => ({ ...current, vote })) }));
  useEffect(() => queue.sync(myVote), [queue, myVote]);

  const shown = score - myVote + state.vote;
  const classes = ['pb-vote', orientation === 'horizontal' && 'pb-vote--row', className].filter(Boolean).join(' ');
  return (
    <Group
      className={classes}
      aria-label={label ?? labels.group}
      data-vote={state.vote === 1 ? 'up' : state.vote === -1 ? 'down' : undefined}
    >
      <ToggleButton
        size="sm"
        className="pb-vote__up"
        aria-label={labels.up}
        selected={state.vote === 1}
        disabled={disabled}
        onChange={() => queue.press(1, save)}
      >
        <ArrowUp />
      </ToggleButton>
      <Text variant="label" size="sm" className="pb-vote__score">
        {new Intl.NumberFormat(locale).format(shown)}
      </Text>
      <ToggleButton
        size="sm"
        className="pb-vote__down"
        aria-label={labels.down}
        selected={state.vote === -1}
        disabled={disabled}
        onChange={() => queue.press(-1, save)}
      >
        <ArrowDown />
      </ToggleButton>
    </Group>
  );
}
