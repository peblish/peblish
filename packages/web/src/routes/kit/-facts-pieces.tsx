import type { CommunityGroup } from '@peblish/core/reports/groups';
import type { ThreadFacts } from '@peblish/core/posts/facts';
import { FactList } from '@peblish/ui/components/fact-list';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import type { ReactNode } from 'react';
import queueCss from '../admin/reports/-ui/queue.css?url';
import { QueueGroups } from '../admin/reports/-ui/groups.tsx';
import instancesCss from '../instances/-ui/instances.css?url';
import { InstancesList } from '../instances/-ui/instances-page.tsx';
import { useThreadFacts } from '../post/-ui/thread-facts.tsx';
import { ModeratesPanel } from '../u/$handle/-ui/moderates-panel.tsx';
import { communities, now } from './-samples.ts';
import type { Composition } from './-states.tsx';

// The facts lane's state pages (/kit/<key>), registered in -states.tsx: the report queue's community
// headings, a profile's Moderates, a thread's facts and the Instances list. Sample content is invented.
// The queue's rows are the queue's own table, whose states are its own; the headings here carry no rows.

function Styled({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <link rel="stylesheet" href={href} precedence="default" />
      {children}
    </div>
  );
}

const named = { ...communities.art, displayName: 'Art and making' };

function Heads({ tab }: { tab: 'open' | 'resolved' }) {
  const groups: CommunityGroup[] = [
    { community: named, openCount: 12, rows: [] },
    { community: communities.fediverse, openCount: 1, rows: [] },
    { community: null, openCount: 3, rows: [] },
  ];
  return (
    <Styled href={queueCss} className="rq-page">
      <QueueGroups groups={groups} tab={tab} admin view={{ tab, community: null, sort: 'oldest' }} now={now.getTime()} />
    </Styled>
  );
}

function Moderates({ more = false }: { more?: boolean }) {
  return (
    <div className="kit-rail">
      <ModeratesPanel moderates={[communities.announcements, communities.art, communities.fediverse]} more={more} />
    </div>
  );
}

function Facts({ facts }: { facts: ThreadFacts }) {
  return (
    <div className="kit-rail">
      <RailPanel title="In this thread">
        <FactList size="xs" items={useThreadFacts(facts)} />
      </RailPanel>
    </div>
  );
}

const known: ThreadFacts = {
  participants: 14,
  more: false,
  lastActivityAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
  language: 'de',
};
const unknown: ThreadFacts = { participants: 1000, more: true, lastActivityAt: null, language: null };

function Instances({ empty = false }: { empty?: boolean }) {
  return (
    <Styled href={instancesCss} className="instances-page">
      <InstancesList
        instances={
          empty
            ? []
            : [
                { domain: 'fedia.example', software: 'mbin' },
                { domain: 'lantern.example', software: 'lemmy' },
                { domain: 'a-very-long-subdomain-of-a-server.somewhere.example', software: 'gnusocial' },
                { domain: 'quiet.example', software: null },
              ]
        }
      />
    </Styled>
  );
}

export const factsPieces: Readonly<Record<string, Composition>> = {
  'queue-groups': { name: 'Report queue community headings', states: { rest: () => <Heads tab="open" /> } },
  'queue-groups-closed': { name: 'Report queue community headings, Resolved tab', states: { rest: () => <Heads tab="resolved" /> } },
  'profile-moderates': { name: 'Profile Moderates panel', states: { rest: () => <Moderates /> } },
  'profile-moderates-more': { name: 'Profile Moderates panel, more than it lists', states: { rest: () => <Moderates more /> } },
  'thread-facts': { name: 'Thread facts in the post rail', states: { rest: () => <Facts facts={known} /> } },
  'thread-facts-unknown': { name: 'Thread facts past one read', states: { rest: () => <Facts facts={unknown} /> } },
  'instances-list': { name: 'Instances list', states: { rest: () => <Instances /> } },
  'instances-list-empty': { name: 'Instances list with none', states: { rest: () => <Instances empty /> } },
};
