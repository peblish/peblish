import { BottomTabBar, type BottomTab } from '@peblish/ui/components/bottom-tab-bar';
import { Button } from '@peblish/ui/components/button';
import { CountBadge } from '@peblish/ui/components/count-badge';
import { EdgeToggle } from '@peblish/ui/components/edge-toggle';
import { IconButton } from '@peblish/ui/components/icon-button';
import {
  ChevronLeft,
  CompassIcon,
  EllipsisIcon,
  HouseIcon,
  InboxIcon,
  InfoIcon,
  LockIcon,
  LogInIcon,
  MapPinIcon,
  SquarePenIcon,
} from '@peblish/ui/components/icons';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { ViewHeader } from '@peblish/ui/components/view-header';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import { useState, type ComponentType } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useVoteLabels } from '../../shell/labels.ts';
import { SiteMenu } from '../../shell/sidebar.tsx';
import { sharedPieces } from './-shared-pieces.tsx';
import { feedPieces } from './-feed.tsx';
// The community page and the directory (community-directory lane).
import { communityPieces } from './-community-pieces.tsx';
import { threadPieces } from './-thread.tsx';
// The inbox's state pages (inbox lane).
import { inboxPieces } from './-inbox.tsx';
import { peoplePieces } from './-people.tsx';
import { staffPieces } from './-staff-pieces.tsx';
import { accountPieces } from './-account-pieces.tsx';
// The site banner and the width setting (banner and width lane).
import { bannerPieces } from './-banner-pieces.tsx';
// The header's finder and Create post's community field (f-finder lane).
import { finderPieces } from './-finder-pieces.tsx';

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
  {
    id: 'inbox',
    href: '/notifications',
    label: 'Inbox',
    icon: <InboxIcon />,
    count: <CountBadge count={3} locale="en" label="3 unread" />,
  },
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

/**
 * The sidebar as the frame's will be once pins arrive (a later branch), so it is laid out before it is used: a
 * folding section whose pinned row has its own action (a row's `action`, a separate tab stop) and ends at a
 * NavDivider before the rest, and, folded into the rail, the site's pages as one menu at the foot.
 */
function Side({ folded }: { folded: boolean }) {
  const [collapsed, setCollapsed] = useState(folded);
  const state = folded ? 'folded' : 'open';
  return (
    <Sidebar.Provider collapsed={collapsed} onCollapsedChange={setCollapsed}>
      <Sidebar.Root aria-label={`Sample sidebar with a pin, ${state}`}>
        <Sidebar.NavList navLabel={`Sample navigation, ${state}`}>
          <Sidebar.NavItem href="/local" icon={MapPinIcon}>
            Local
          </Sidebar.NavItem>
          <Sidebar.Section label="Communities" collapsible>
            <Sidebar.NavItem
              href="/c/bushwalking"
              icon={CompassIcon}
              action={
                <IconButton size="sm" variant="ghost" aria-label="Options for Bushwalking">
                  <EllipsisIcon />
                </IconButton>
              }
            >
              Bushwalking
            </Sidebar.NavItem>
            <Sidebar.NavDivider />
            <Sidebar.NavItem href="/c/coffee" icon={CompassIcon}>
              Coffee
            </Sidebar.NavItem>
          </Sidebar.Section>
        </Sidebar.NavList>
        {collapsed && (
          <SiteMenu
            siteName="Sample site"
            pages={[
              { href: '/about', label: 'About', icon: InfoIcon },
              { href: '/privacy', label: 'Privacy', icon: LockIcon },
            ]}
          />
        )}
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
  sidebar: {
    name: 'Sidebar with a pin',
    states: { rest: () => <Side folded={false} />, selected: () => <Side folded /> },
  },
  ...sharedPieces,
  ...feedPieces,
  // The community page and the directory (community-directory lane).
  ...communityPieces,
  ...threadPieces,
  ...inboxPieces,
  ...peoplePieces,
  ...staffPieces,
  ...accountPieces,
  ...bannerPieces,
  ...finderPieces,
};
