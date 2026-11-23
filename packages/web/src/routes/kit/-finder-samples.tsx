import { Card } from '@peblish/ui/components/card';
import { CommunityField, type CommunityGroup } from '@peblish/ui/components/community-field';
import { FinderPanel, type FinderLookup, type FinderPanelProps, type FinderRow } from '@peblish/ui/components/community-finder';
import { CommandPalette } from '@peblish/ui/components/command-palette';
import { useState } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import finderCss from './-finder.css?url';

// The samples of the finder's and Create post's community field's state pages (-finder-pieces.tsx), loaded only when a
// state page draws one. The finder's contents are drawn inline (its popup is modal, one at a time), inside a Root and an outlined Card for
// its surface. Sample content is invented; the words come from the finder's and the composer's catalogues.

const joined: FinderRow[] = [
  { id: 'tidepools', title: 'Tide pools', handle: 'tidepools', href: '/c/tidepools' },
  { id: 'loomwork', title: 'Loomwork', handle: 'loomwork@weave.example', href: '/c/loomwork@weave.example', note: 'request pending' },
];
const others: FinderRow[] = [
  { id: 'tidewater', title: 'Tidewater rowing', handle: 'tidewater', href: '/c/tidewater' },
  { id: 'tides', title: 'Tide tables', handle: 'tides@sea.example', href: '/c/tides@sea.example' },
];

function Finder({ status = 'ready', query = 'tide', rows = true, lookup = null }: Partial<FinderPanelProps> & { rows?: boolean }) {
  const { t } = useTranslate();
  const [text, setText] = useState(query);
  return (
    <CommandPalette.Root>
      <link rel="stylesheet" href={finderCss} />
      <Card.Root variant="outlined" padding="sm" className="pb-finder-sample">
        <FinderPanel
          query={text}
          onQueryChange={setText}
          joined={rows ? joined : []}
          others={rows ? others : []}
          lookup={lookup}
          onLookup={() => undefined}
          status={status}
          onRetry={() => undefined}
          announcement={rows ? '4 communities' : t('finder', 'count.none')}
          autoFocus={false}
          labels={{
            field: t('shell', 'find'),
            placeholder: t('finder', 'placeholder'),
            clear: t('finder', 'clear'),
            results: t('finder', 'results'),
            joined: t('finder', 'joined'),
            others: t('finder', 'others'),
            lookup: t('finder', 'lookup'),
            loading: t('finder', 'loading'),
            error: t('finder', 'error'),
            retry: t('finder', 'retry'),
            noneTitle: t('finder', 'none.title'),
            noneBody: t('finder', 'none.body'),
          }}
        />
      </Card.Root>
    </CommandPalette.Root>
  );
}

function Lookup() {
  const { t } = useTranslate();
  const lookup: FinderLookup = {
    title: t('finder', 'lookup.title', { text: '!tides@sea.example' }),
    description: t('finder', 'lookup.asks', { host: 'sea.example' }),
  };
  return <Finder query="!tides@sea.example" rows={false} lookup={lookup} />;
}

function Field({ value = null, invalid = false }: { value?: string | null; invalid?: boolean }) {
  const { t } = useTranslate();
  const [chosen, setChosen] = useState(value);
  const groups: CommunityGroup[] = [
    {
      id: 'joined',
      title: t('composer', 'community.joined'),
      options: [
        { id: 'tidepools', displayName: 'Tide pools', handle: 'tidepools', description: 'local, 1,204 members' },
        { id: 'loomwork', displayName: null, handle: 'loomwork@weave.example', description: 'remote, subscribed' },
      ],
    },
    {
      id: 'others',
      title: t('composer', 'community.others'),
      options: [
        { id: 'notices', displayName: null, handle: 'notices', description: 'local, mods only, posting disabled for you', disabled: true },
      ],
    },
  ];
  return (
    <form className="pb-cfield-sample" onSubmit={(event) => event.preventDefault()}>
      <link rel="stylesheet" href={finderCss} />
      <CommunityField
        name="community"
        groups={groups}
        value={chosen}
        onChange={setChosen}
        onBrowse={() => undefined}
        labels={{
          label: t('composer', 'community.label'),
          placeholder: t('composer', 'community.search'),
          elsewhere: t('composer', 'community.elsewhere'),
          browse: t('composer', 'community.browse'),
          none: t('composer', 'community.none'),
        }}
        error={invalid ? t('composer', 'error.community.required') : undefined}
        required
        fallback={null}
      />
    </form>
  );
}

/** One sample, by name: what -finder-pieces.tsx loads when a state page draws it. */
export type SampleName = 'results' | 'loading' | 'error' | 'empty' | 'none' | 'lookup' | 'field' | 'field-chosen' | 'field-refused';

export default function FinderSample({ name }: { name: SampleName }) {
  switch (name) {
    case 'results':
      return <Finder />;
    case 'loading':
      return <Finder status="loading" rows={false} />;
    case 'error':
      return <Finder status="error" rows={false} />;
    case 'empty':
      return <Finder query="" />;
    case 'none':
      return <Finder query="zzz" rows={false} />;
    case 'lookup':
      return <Lookup />;
    case 'field':
      return <Field />;
    case 'field-chosen':
      return <Field value="tidepools" />;
    case 'field-refused':
      return <Field invalid />;
  }
}
