import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { Badge } from '@peblish/ui/components/badge';
import {
  CommunityList,
  CommunityListSkeleton,
  CommunityViewControl,
  type CommunityListItem,
  type CommunityView,
} from '@peblish/ui/components/community-list';
import { Handle } from '@peblish/ui/components/handle';
import { JoinButton, type JoinState } from '@peblish/ui/components/join-button';
import { useState } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import type { Composition } from './-states.tsx';

// The community page's and the directory's state pages (/kit/<key>, community-directory lane), registered in
// -states.tsx. Sample content is invented; the words come from the communities and directory catalogues.

function Join({ state, busy, failed }: { state: JoinState; busy?: boolean; failed?: boolean }) {
  const { t } = useTranslate();
  return (
    // A form, as on the page; the sample never posts.
    <form className="kit-row" onSubmit={(event) => event.preventDefault()}>
      <JoinButton
        state={state}
        busy={busy}
        labels={{
          join: t('communities', 'page.join'),
          joined: t('communities', 'page.joined'),
          leave: t('communities', 'page.leave'),
          pending: t('communities', 'page.pending'),
          cancel: t('communities', 'page.cancelPending'),
        }}
        error={failed ? t('communities', 'error.generic') : undefined}
      />
    </form>
  );
}

const samples = [
  {
    name: 'tidepools',
    title: 'Tide pools',
    subscribers: '1,204 subscribers',
    about: 'Rock pools, the creatures in them, and how to visit without harming them.',
  },
  {
    name: 'loomwork@weave.example',
    title: 'Loomwork',
    subscribers: '88 subscribers',
    about: 'Hand looms and the cloth they make. Drafts welcome.',
  },
  { name: 'fern_spotting', title: 'Fern spotting', subscribers: '3 subscribers', about: null, nsfw: true },
];

function List({ view }: { view: CommunityView }) {
  const { t } = useTranslate();
  const labels = {
    join: t('directory', 'directory.row.join'),
    joined: t('directory', 'directory.row.joined'),
    leave: t('directory', 'directory.row.leave'),
    pending: t('directory', 'directory.row.pending'),
    cancel: t('directory', 'directory.row.cancel'),
  };
  const states: JoinState[] = ['joined', 'pending', 'none'];
  const items: CommunityListItem[] = samples.map((sample, index) => ({
    id: `${view}-${sample.name}`,
    href: `/c/${sample.name}`,
    linkId: `kit-${view}-${index}`,
    title: sample.title,
    initial: avatarInitial(sample.title, '?'),
    meta: (
      <>
        <Handle prefix="!" handle={sample.name} /> · {sample.subscribers}
      </>
    ),
    badges: sample.nsfw ? <Badge kind="nsfw">{t('directory', 'directory.row.nsfw')}</Badge> : undefined,
    about: sample.about ?? undefined,
    action: (
      <form onSubmit={(event) => event.preventDefault()}>
        <JoinButton state={states[index]!} size="sm" quiet labels={labels} describedBy={`kit-${view}-${index}`} />
      </form>
    ),
  }));
  return <CommunityList view={view} label={`Sample communities, ${view}`} items={items} />;
}

function View({ initial }: { initial: CommunityView }) {
  const { t } = useTranslate();
  const [view, setView] = useState(initial);
  return (
    <CommunityViewControl
      value={view}
      onChange={setView}
      labels={{
        group: t('directory', 'directory.view.group'),
        list: t('directory', 'directory.view.list'),
        cards: t('directory', 'directory.view.cards'),
      }}
    />
  );
}

function Skeleton({ view }: { view: CommunityView }) {
  const { t } = useTranslate();
  return <CommunityListSkeleton view={view} label={t('directory', 'directory.loading')} />;
}

export const communityPieces: Readonly<Record<string, Composition>> = {
  'join-button': {
    name: 'Join',
    states: {
      rest: () => <Join state="none" />,
      selected: () => <Join state="joined" />,
      pending: () => <Join state="none" busy />,
      invalid: () => <Join state="none" failed />,
    },
  },
  'join-button-requested': {
    name: 'Join, requested from another server',
    states: {
      rest: () => <Join state="pending" />,
      pending: () => <Join state="pending" busy />,
      invalid: () => <Join state="pending" failed />,
    },
  },
  'community-list': { name: 'Directory, List', states: { rest: () => <List view="list" /> } },
  'community-cards': { name: 'Directory, Cards', states: { rest: () => <List view="cards" /> } },
  'community-view': {
    name: 'Directory view, List or Cards',
    states: { rest: () => <View initial="list" />, selected: () => <View initial="cards" /> },
  },
  'community-skeleton': {
    name: 'Directory loading',
    states: { pending: () => <Skeleton view="list" /> },
  },
};
