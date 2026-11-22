import { useId, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { CheckIcon, HourglassIcon } from './icons.tsx';
import { Notice } from './notice.tsx';

/** Where the viewer stands with a community: not in it, asked its home server and waiting, or in it. */
export type JoinState = 'none' | 'pending' | 'joined';

export interface JoinButtonLabels {
  join: string;
  joined: string;
  /** What pressing Joined does ("Leave"): read after the label, as the button's name. */
  leave: string;
  pending: string;
  /** What pressing Pending does ("Cancel request"). */
  cancel: string;
}

export interface JoinButtonProps {
  state: JoinState;
  labels: JoinButtonLabels;
  size?: 'sm' | 'md';
  /** Join in the neutral fill, for a list of communities where a column of primary buttons would shout. */
  quiet?: boolean;
  /** The request is on its way: Mux's pending button, which keeps its place and says it is busy. */
  busy?: boolean;
  /** Why the last press failed, said under the button and read as its description. */
  error?: ReactNode;
  /** The id of what the button acts on (a community's name in a list), read as part of its description. */
  describedBy?: string;
}

/**
 * Join, Joined or Pending (Commons, the mock's JoinButton): a submit button, so the form around it
 * posts with scripts off. Joined and Pending carry a glyph as well as their word, never colour alone,
 * and are named for what a press does ("Joined, leave"; "Pending, cancel request"). A refusal is a
 * danger Notice under the button that the button names as its description.
 */
export function JoinButton({ state, labels, size = 'md', quiet = false, busy = false, error, describedBy }: JoinButtonProps) {
  const errorId = useId();
  const described = [describedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const common = { type: 'submit' as const, size, pending: busy, 'aria-describedby': described, 'data-join': state };
  const button =
    state === 'joined' ? (
      <Button {...common} variant="neutral" className="pb-join" aria-label={`${labels.joined}, ${labels.leave}`}>
        <CheckIcon />
        {labels.joined}
      </Button>
    ) : state === 'pending' ? (
      <Button {...common} variant="neutral" className="pb-join" aria-label={`${labels.pending}, ${labels.cancel}`}>
        <HourglassIcon />
        {labels.pending}
      </Button>
    ) : (
      <Button {...common} variant={quiet ? 'neutral' : 'primary'} className="pb-join">
        {labels.join}
      </Button>
    );
  return (
    <>
      {button}
      {error && (
        <Notice tone="danger" role="alert" id={errorId} className="pb-join__error">
          {error}
        </Notice>
      )}
    </>
  );
}
