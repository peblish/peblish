import { ButtonLink } from '@peblish/ui/components/button-link';
import { InfoIcon, LockIcon, SettingsIcon, UserRoundIcon } from '@peblish/ui/components/icons';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Text } from '@peblish/ui/components/text';
import type { Scheme } from '@peblish/ui/theme/root';
import { useState, type ReactNode } from 'react';
import type { ProfileData } from '../u/$handle/-load.ts';
import { ProfileHero } from '../u/$handle/-ui/profile-hero.tsx';
import profileCss from '../u/$handle/-ui/profile.css?url';
import { AppearanceChoice, YouLinks } from '../you/-ui/you-parts.tsx';
import youCss from '../you/-ui/you.css?url';
import { now, people } from './-samples.ts';
import type { Composition } from './-states.tsx';

// The people area's state pages (/kit/<key>): a profile's header and tabs, and the You page's parts,
// registered in -states.tsx. Sample content is invented. Each sample loads its route's stylesheet (React
// hoists and dedupes it) inside the class its route gives <main>, so the phone sizes apply as they do there.

function Styled({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <link rel="stylesheet" href={href} precedence="default" />
      {children}
    </div>
  );
}

const person: ProfileData = {
  person: people.mira,
  initial: 'M',
  avatarSrc: null,
  bioHtml: '<p>I walk the <strong>Blue Mountains</strong> and write about the tracks.</p>',
  joinedAt: '2024-03-02T09:00:00Z',
  counts: { posts: 128, comments: 2_045 },
  badges: { admin: false, moderator: true, bot: false, you: true },
  home: { host: 'lantern.example', age: '3h' },
  state: 'live',
  blocked: null,
  moderatedCommunities: [],
  moderates: [],
  moderatesMore: false,
  homeSoftware: null,
  indexable: true,
  viewer: null,
  tab: 'posts',
  sort: 'new',
  after: null,
  entries: [],
  next: null,
  now: now.toISOString(),
};

function Hero() {
  return (
    <Styled href={profileCss} className="prof">
      <ProfileHero data={person}>
        <ButtonLink href="/kit/profile-header#edit" variant="neutral">
          Edit profile
        </ButtonLink>
        <ButtonLink href="/kit/profile-header#settings" variant="neutral">
          Settings
        </ButtonLink>
      </ProfileHero>
    </Styled>
  );
}

/** A profile's tabs and sort, as link tabs; `current` is the tab and sort shown. */
function Tabs({ current }: { current?: 'posts' }) {
  const tab = (id: string, label: string, count?: string) => ({
    to: `/kit/profile-tabs?tab=${id}`,
    active: current === id,
    label: (
      <>
        {label}
        {count && (
          <Text color="muted" className="prof-tab-count">
            {' '}
            {count}
          </Text>
        )}
      </>
    ),
  });
  const state = current ? 'Posts current' : 'none current';
  return (
    <Styled href={profileCss} className="prof">
      <LinkTabs
        aria-label={`Activity, ${state}`}
        items={[tab('overview', 'Overview'), tab('posts', 'Posts', '128'), tab('comments', 'Comments', '2,045')]}
      />
      <LinkTabs
        aria-label={`Sort, ${state}`}
        variant="segment"
        size="sm"
        items={[
          { to: '/kit/profile-tabs?sort=new', active: current !== undefined, label: 'New' },
          { to: '/kit/profile-tabs?sort=top', label: 'Top' },
        ]}
      />
    </Styled>
  );
}

function Links() {
  return (
    <Styled href={youCss} className="you">
      <YouLinks
        title="Account"
        links={[
          { href: '/kit/you-links#profile', label: 'Profile', icon: UserRoundIcon },
          { href: '/kit/you-links#settings', label: 'Settings', icon: SettingsIcon },
        ]}
      />
      <YouLinks
        title="Sample site"
        links={[
          { href: '/kit/you-links#about', label: 'About', icon: InfoIcon },
          { href: '/kit/you-links#privacy', label: 'Privacy', icon: LockIcon },
        ]}
      />
    </Styled>
  );
}

/** Appearance, with its own state so the gallery's scheme stays as it is. */
function Appearance({ initial = 'system', disabled }: { initial?: Scheme; disabled?: boolean }) {
  const [scheme, setScheme] = useState<Scheme>(initial);
  return (
    <Styled href={youCss} className="you">
      <AppearanceChoice value={scheme} onChange={setScheme} disabled={disabled} />
    </Styled>
  );
}

export const peoplePieces: Readonly<Record<string, Composition>> = {
  'profile-header': { name: 'Profile header', states: { rest: Hero } },
  'profile-tabs': {
    name: 'Profile tabs and sort',
    states: { rest: () => <Tabs />, selected: () => <Tabs current="posts" /> },
  },
  'you-links': { name: 'You page links', states: { rest: Links } },
  'you-appearance': {
    name: 'You page appearance',
    states: { rest: () => <Appearance />, selected: () => <Appearance initial="dark" />, disabled: () => <Appearance disabled /> },
  },
};
