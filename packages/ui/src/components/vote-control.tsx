import { useEffect, useState } from 'react';
import { Group } from './group.tsx';
import { VoteDownIcon, VoteUpIcon } from './icons.tsx';
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
  /** `pill` sits the arrows and score on a neutral pill (a post's action row); `plain` has no fill (comments, Compact rows). */
  variant?: 'pill' | 'plain';
  labels: VoteControlLabels;
  /** The group's name when it should say what the vote is on ("Vote on <title>"); `labels.group` otherwise. */
  label?: string;
  locale: string;
  className?: string;
}

/**
 * Up and down arrows with the score between them: a Mux UI Group of two ToggleButtons (pressed
 * state, `aria-pressed`) and the score in Mux Text, which is passive (not announced as it changes).
 * Not a ToggleButtonGroup: its single selection is a radio group, and a vote must be removable.
 * Optimistic: the viewer's choice shows before `onVote` settles. The cast arrow is filled as well
 * as taking the --pb-up or --pb-down accent, so the vote never shows by colour alone. On a phone
 * each arrow is a 44px target around a smaller glyph.
 */
export function VoteControl({
  score,
  myVote,
  onVote,
  disabled,
  orientation = 'vertical',
  variant = 'plain',
  labels,
  label,
  locale,
  className,
}: VoteControlProps) {
  const [state, setState] = useState({ base: myVote, vote: myVote });
  // A new value from the server replaces the optimistic one (derived state, set while rendering).
  if (state.base !== myVote) setState({ base: myVote, vote: myVote });

  // While a vote is being saved the group is busy (aria-busy); the arrows already show it.
  const [saving, setSaving] = useState(false);
  const save = async (value: Vote) => {
    setSaving(true);
    try {
      await onVote?.(value);
    } finally {
      setSaving(false);
    }
  };
  const [queue] = useState(() => createVoteQueue({ initial: myVote, onChange: (vote) => setState((current) => ({ ...current, vote })) }));
  useEffect(() => queue.sync(myVote), [queue, myVote]);

  const shown = score - myVote + state.vote;
  const classes = ['pb-vote', orientation === 'horizontal' && 'pb-vote--row', variant === 'pill' && 'pb-vote--pill', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Group
      className={classes}
      aria-label={label ?? labels.group}
      aria-busy={saving || undefined}
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
        <VoteUpIcon />
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
        <VoteDownIcon />
      </ToggleButton>
    </Group>
  );
}
