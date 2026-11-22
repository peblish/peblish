import type { ShellCommunity } from '@peblish/schema/views';
import { Notice } from '@peblish/ui/components/notice';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { useState, type ReactNode } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { SidebarCommunities } from '../../shell/sidebar-communities.tsx';
import { MoveButton, PinButton, PinnedGroup } from '../communities/-ui/pin-controls.tsx';
import type { Composition } from './-states.tsx';

// The pins lane's state pages (/kit/<key>), registered in -states.tsx: the directory's Pin and Move controls,
// its pinned group, and the sidebar's Communities rows with pins, a pending follow and a pinned row's menu.
// Sample content is invented; the words come from the pins catalogue. The samples' forms never post.

const sample = (form: ReactNode) => (
  <form className="kit-row" onSubmit={(event) => event.preventDefault()}>
    {form}
  </form>
);

function Pin({ pinned = false, busy, failed }: { pinned?: boolean; busy?: boolean; failed?: boolean }) {
  const { t } = useTranslate();
  return sample(
    <>
      <PinButton pinned={pinned} name="Tide pools" busy={busy} />
      {failed && (
        <Notice tone="danger" role="alert">
          {t('pins', 'pins.error.generic')}
        </Notice>
      )}
    </>,
  );
}

function Move({ place, busy }: { place: 'first' | 'middle'; busy?: boolean }) {
  return sample(
    <>
      <MoveButton way="up" name="Loomwork" disabled={place === 'first'} busy={busy} />
      <MoveButton way="down" name="Loomwork" busy={busy} />
    </>,
  );
}

const community = (id: string, name: string, title: string, extra: Partial<ShellCommunity> = {}): ShellCommunity => ({
  id: `0190a000-0000-7000-8000-00000000000${id}`,
  apId: `https://kit.example/c/${name}`,
  kind: 'Group',
  name,
  displayName: title,
  local: true,
  handle: name,
  followState: 'accepted',
  pinned: false,
  pinPosition: null,
  ...extra,
});

const followed: ShellCommunity[] = [
  community('1', 'tidepools', 'Tide pools', { pinned: true, pinPosition: 1 }),
  community('2', 'loomwork', 'Loomwork', { pinned: true, pinPosition: 0 }),
  community('3', 'fern_spotting', 'Fern spotting', { followState: 'pending', pinned: true, pinPosition: 2 }),
  community('4', 'abacus', 'Abacus makers'),
  community('5', 'quilting', 'Quilting circle', { followState: 'pending' }),
];

function Side({ folded }: { folded: boolean }) {
  const [collapsed, setCollapsed] = useState(folded);
  const state = folded ? 'folded' : 'open';
  return (
    <Sidebar.Provider collapsed={collapsed} onCollapsedChange={setCollapsed}>
      <Sidebar.Root aria-label={`Sample sidebar with pins, ${state}`}>
        <Sidebar.NavList navLabel={`Sample communities, ${state}`}>
          <Sidebar.Section label="Communities">
            <SidebarCommunities local={followed} remote={[]} pathname="/c/tidepools" signedIn />
          </Sidebar.Section>
        </Sidebar.NavList>
      </Sidebar.Root>
    </Sidebar.Provider>
  );
}

const pinnedOnly = followed.filter((c) => c.pinned).sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0));

export const pinsPieces: Readonly<Record<string, Composition>> = {
  'pin-toggle': {
    name: 'Pin',
    states: {
      rest: () => <Pin />,
      selected: () => <Pin pinned />,
      pending: () => <Pin busy />,
      invalid: () => <Pin failed />,
    },
  },
  'pin-move': {
    name: 'Move up and Move down',
    states: {
      rest: () => <Move place="middle" />,
      disabled: () => <Move place="first" />,
      pending: () => <Move place="middle" busy />,
    },
  },
  'pinned-group': {
    name: 'Pinned communities',
    states: {
      rest: () => <PinnedGroup pinned={pinnedOnly} view="list" next="/kit/pinned-group" />,
      selected: () => <PinnedGroup pinned={pinnedOnly} view="cards" next="/kit/pinned-group" />,
    },
  },
  'sidebar-pins': {
    name: 'Sidebar with pins',
    states: { rest: () => <Side folded={false} />, selected: () => <Side folded /> },
  },
};
