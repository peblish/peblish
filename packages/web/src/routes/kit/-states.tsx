import { BottomTabBar, type BottomTab } from '@peblish/ui/components/bottom-tab-bar';
import { Button } from '@peblish/ui/components/button';
import { EdgeToggle } from '@peblish/ui/components/edge-toggle';
import { IconButton } from '@peblish/ui/components/icon-button';
import { ChevronLeft, CompassIcon, HouseIcon, InboxIcon, LogInIcon, MapPinIcon, SquarePenIcon } from '@peblish/ui/components/icons';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { ViewHeader } from '@peblish/ui/components/view-header';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import { useState, type ComponentType } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useVoteLabels } from '../../shell/labels.ts';
import { sharedPieces } from './-shared-pieces.tsx';

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

// The Commons frame's compositions (frame lane). Each sample's landmark has a name of its own, beside the frame's.
const tabs = (current?: string): BottomTab[] => [
  { id: 'home', href: '/', label: 'Home', icon: <HouseIcon />, current: current === 'home' },
  { id: 'communities', href: '/communities', label: 'Communities', icon: <CompassIcon /> },
  { id: 'create', href: '/submit', label: 'Create', icon: <SquarePenIcon /> },
  { id: 'inbox', href: '/notifications', label: 'Inbox', icon: <InboxIcon />, count: { shown: '3', spoken: 'unread' } },
  { id: 'sign-in', href: '/auth/sign-in', label: 'Sign in', icon: <LogInIcon /> },
];

function Bar() {
  return (
    <ViewHeader
      leading={
        <IconButton variant="ghost" aria-label="Back">
          <ChevronLeft />
        </IconButton>
      }
      title={<Text variant="label">Inbox</Text>}
      trailing={<Button variant="neutral">Mark all read</Button>}
    />
  );
}

/** The fold's toggle beside the sidebar it folds (its aria-controls), in a provider of its own. */
function Fold({ folded }: { folded: boolean }) {
  const [collapsed, setCollapsed] = useState(folded);
  const labels = { name: `Sample sidebar, ${folded ? 'folded' : 'open'}`, collapse: 'Collapse sidebar', expand: 'Expand sidebar' };
  return (
    <Sidebar.Provider collapsed={collapsed} onCollapsedChange={setCollapsed}>
      <EdgeToggle collapsed={collapsed} labels={labels} />
      <Sidebar.Root aria-label={labels.name}>
        <Sidebar.NavList>
          <Sidebar.NavItem href="/local" icon={MapPinIcon}>
            Local
          </Sidebar.NavItem>
        </Sidebar.NavList>
      </Sidebar.Root>
    </Sidebar.Provider>
  );
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
  'view-header': { name: 'View header', states: { rest: Bar } },
  'bottom-tab-bar': {
    name: 'Bottom tab bar',
    states: {
      rest: () => <BottomTabBar label="Sections, none current" tabs={tabs()} />,
      selected: () => <BottomTabBar label="Sections, Home current" tabs={tabs('home')} />,
    },
  },
  'edge-toggle': {
    name: 'Edge toggle',
    states: { rest: () => <Fold folded />, selected: () => <Fold folded={false} /> },
  },
  ...sharedPieces,
};
