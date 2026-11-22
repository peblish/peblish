import { Handle } from '@peblish/ui/components/handle';
import { RailLinks } from '@peblish/ui/components/rail-links';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { SectionTabs } from '@peblish/ui/components/section-tabs';
import type { Composition } from './-states.tsx';

// The staff pages' pieces' state pages (/kit/<key>), registered in -states.tsx: the admin tabs and the
// rail's lists of places (the report queue's communities, the modlog's filters). Sample content is invented.

const sections = ['Settings', 'Pages', 'Reports', 'Bans', 'Peers', 'Media'];

function Tabs({ current }: { current?: string }) {
  return (
    <SectionTabs
      aria-label={`Sample sections, ${current ?? 'none'} current`}
      items={sections.map((name) => ({ to: `/kit/section-tabs#${name.toLowerCase()}`, label: name, active: name === current }))}
    />
  );
}

function Places({ current }: { current?: string }) {
  const rows = [
    { key: 'all', label: 'All', count: '13' },
    { key: 'art', label: <Handle prefix="!" handle="art" />, count: '4' },
    { key: 'birds', label: <Handle prefix="!" handle="birds@example.test" />, count: '1' },
  ];
  return (
    <div className="kit-rail">
      <RailPanel title="Community">
        <RailLinks items={rows.map((row) => ({ ...row, href: `/kit/rail-links#${row.key}`, current: row.key === current }))} />
      </RailPanel>
    </div>
  );
}

export const staffPieces: Readonly<Record<string, Composition>> = {
  'section-tabs': {
    name: 'Section tabs',
    states: { rest: () => <Tabs />, selected: () => <Tabs current="Reports" /> },
  },
  'rail-links': {
    name: 'RailLinks in a RailPanel',
    states: { rest: () => <Places />, selected: () => <Places current="art" /> },
  },
};
