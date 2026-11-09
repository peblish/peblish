import { castVoteFn } from '../-vote.ts';
import { useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

type Vote = -1 | 0 | 1;

/**
 * The vote column: up and down arrows around the score, two plain buttons so the first tap
 * right after hydration is not lost. Optimistic; the server's tally replaces the numbers when
 * it answers, and a refusal puts the old ones back. Remount it (a key) when the page's data
 * reloads. Stand-in for @peblish/ui's VoteControl, which takes the same onVote(value) shape.
 */
export function PostVote({
  postId,
  up,
  down,
  myVote,
  disabled,
}: {
  postId: string;
  up: number;
  down: number;
  myVote: Vote;
  disabled: boolean;
}) {
  const { t, locale } = useTranslate();
  const [state, setState] = useState({ vote: myVote, score: up - down });

  async function cast(value: 1 | -1) {
    const before = state;
    const next: Vote = before.vote === value ? 0 : value;
    setState({ vote: next, score: before.score - before.vote + next });
    try {
      const result = await castVoteFn({ data: { target: { kind: 'post', id: postId }, value: next } });
      if (!result.ok) return setState(before);
      setState({ vote: result.value, score: result.tally.upvotes - result.tally.downvotes });
    } catch {
      setState(before);
    }
  }

  return (
    <div className="post-vote" role="group" aria-label={t('posts', 'vote.group')}>
      <button type="button" aria-label={t('posts', 'vote.up')} aria-pressed={state.vote === 1} disabled={disabled} onClick={() => cast(1)}>
        ▲
      </button>
      <output aria-live="polite">{new Intl.NumberFormat(locale).format(state.score)}</output>
      <button
        type="button"
        aria-label={t('posts', 'vote.down')}
        aria-pressed={state.vote === -1}
        disabled={disabled}
        onClick={() => cast(-1)}
      >
        ▼
      </button>
    </div>
  );
}
