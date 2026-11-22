import { Button } from '@peblish/ui/components/button';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import type { ComponentType } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useVoteLabels } from '../../shell/labels.ts';

/**
 * The states a state page shows as samples, in the state matrix's order ('selected' stands for current, checked
 * and expanded). The shared helper e2e/support/states.ts drives the rest sample into hover, focus and press.
 */
export const kitStates = ['rest', 'selected', 'disabled', 'pending', 'invalid'] as const;
export type KitState = (typeof kitStates)[number];

/** A composition's state page: its heading and one sample for each state it takes as a prop. */
export interface Composition {
  name: string;
  states: Partial<Record<KitState, ComponentType>>;
}

function Vote({ myVote = 0, disabled }: { myVote?: Vote; disabled?: boolean }) {
  const { locale } = useTranslate();
  const labels = useVoteLabels();
  return <VoteControl score={3} myVote={myVote} orientation="horizontal" disabled={disabled} labels={labels} locale={locale} />;
}

/** The compositions with a state page at /kit/<key>. */
export const compositions: Readonly<Record<string, Composition>> = {
  button: {
    name: 'Button, primary',
    states: {
      rest: () => <Button variant="primary">Publish</Button>,
      disabled: () => (
        <Button variant="primary" disabled>
          Publish
        </Button>
      ),
      pending: () => (
        <Button variant="primary" pending>
          Publish
        </Button>
      ),
    },
  },
  'vote-control': {
    name: 'Vote control',
    states: {
      rest: () => <Vote />,
      selected: () => <Vote myVote={1} />,
      disabled: () => <Vote disabled />,
    },
  },
};
