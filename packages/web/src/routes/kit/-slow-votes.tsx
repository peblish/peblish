import { Text } from '@peblish/ui/components/text';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import { useRef, useState } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useVoteLabels } from '../../shell/labels.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A vote control whose saver takes 250 ms and writes what it saw to a log, for the e2e check
 * that saves never overlap and that a refusal settling late does not undo a newer choice. With
 * `refuseUp` the saver refuses an up vote (logged as "1!").
 */
function SlowVote({ id, refuseUp }: { id: string; refuseUp?: boolean }) {
  const { locale } = useTranslate();
  const labels = useVoteLabels();
  const [log, setLog] = useState<string[]>([]);
  const pending = useRef(0);

  async function save(value: Vote) {
    // A second request while one is pending would be a bug in the control.
    const overlap = pending.current > 0;
    pending.current += 1;
    await delay(250);
    pending.current -= 1;
    const refused = refuseUp && value === 1;
    setLog((entries) => [...entries, `${value}${refused ? '!' : ''}${overlap ? ' overlap' : ''}`]);
    if (refused) throw new Error('refused');
  }

  return (
    <div data-testid={id}>
      <VoteControl score={5} myVote={0} orientation="horizontal" onVote={save} labels={labels} locale={locale} />
      <output data-testid={`${id}-log`}>
        <Text as="span">{log.join(',')}</Text>
      </output>
    </div>
  );
}

export function SlowVotes() {
  return (
    <>
      <SlowVote id="kit-vote-slow" />
      <SlowVote id="kit-vote-slow-refusing" refuseUp />
    </>
  );
}
