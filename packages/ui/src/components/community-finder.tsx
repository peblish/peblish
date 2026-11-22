import { CommandPalette } from '@muxui/react';
import { Button } from './button.tsx';
import { FinderSkeleton } from './community-finder-pending.tsx';
import { BidiText, Handle, neutraliseBidi } from './handle.tsx';
import { SearchIcon } from './icons.tsx';
import { Text } from './text.tsx';

/** A community the finder lists: a link to its page. */
export interface FinderRow {
  id: string;
  /** Its display name, else its name (isolated, its directional controls dropped). */
  title: string;
  /** `name`, or `name@host` for one on another server: drawn as `!name@host`. */
  handle: string;
  href: string;
  /** After the handle, such as "request pending". */
  note?: string;
}

/** The last row: what was typed, as a handle or an address, sent to the resolve flow when chosen. */
export interface FinderLookup {
  title: string;
  /** Where it will ask, then that it is asking, or why it could not. */
  description: string;
  pending?: boolean;
  /** For a visitor: the lookup page to open instead, which says who may ask. */
  href?: string;
}

export interface FinderLabels {
  /** The field's name, also the popup's. */
  field: string;
  placeholder: string;
  clear: string;
  /** The list of results. */
  results: string;
  joined: string;
  others: string;
  lookup: string;
  /** The loading status, read once. */
  loading: string;
  error: string;
  retry: string;
  noneTitle: string;
  noneBody: string;
}

export interface FinderPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  joined: readonly FinderRow[];
  others: readonly FinderRow[];
  lookup: FinderLookup | null;
  onLookup: () => void;
  /**
   * `loading`: the answer for the current text is on its way; with nothing to show yet the list stands in skeleton
   * rows, otherwise the rows shown stay until it lands. `error`: it failed, with Retry.
   */
  status: 'ready' | 'loading' | 'error';
  onRetry: () => void;
  /** Read politely whenever it changes: how many communities are shown (the loading line stands in while nothing is). */
  announcement: string;
  labels: FinderLabels;
  /** The field takes focus when the panel mounts (the popup's); a gallery sample passes false. */
  autoFocus?: boolean;
}

function Row({ row }: { row: FinderRow }) {
  return (
    <CommandPalette.Item
      id={row.id}
      textValue={neutraliseBidi(`${row.title} !${row.handle}`, '')}
      href={row.href}
      className="pb-finder__row"
    >
      <CommandPalette.ItemContent>
        <CommandPalette.ItemTitle>
          <BidiText text={row.title} />
        </CommandPalette.ItemTitle>
        <CommandPalette.ItemDescription>
          <Handle prefix="!" handle={row.handle} />
          {row.note && `, ${row.note}`}
        </CommandPalette.ItemDescription>
      </CommandPalette.ItemContent>
    </CommandPalette.Item>
  );
}

/**
 * The finder's contents (Commons): Mux CommandPalette's search row, then the results in named groups, Joined, More
 * communities and, last, the typed handle to find. The arrows run through every group as one list and Enter opens the
 * row; Escape empties the field, then closes the popup. The results sit in a block of one height whatever they are
 * (skeleton, rows, nothing, an error), so nothing below or around it moves when they arrive. Renders inside
 * `CommandPalette.Root`: in the popup (CommunityFinder), or inline on a gallery page.
 */
export function FinderPanel({
  query,
  onQueryChange,
  joined,
  others,
  lookup,
  onLookup,
  status,
  onRetry,
  announcement,
  labels,
  autoFocus = true,
}: FinderPanelProps) {
  const empty = joined.length === 0 && others.length === 0 && lookup === null;
  const busy = status === 'loading';
  return (
    <CommandPalette.Content autoFocusFirst className="pb-finder">
      <CommandPalette.SearchField aria-label={labels.field} className="pb-finder__field">
        <SearchIcon className="pb-finder__field-icon" />
        <CommandPalette.Input
          aria-label={labels.field}
          placeholder={labels.placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          // Escape empties the field first, and then, on an empty field, closes the popup. The Autocomplete under the
          // field keeps its own copy of the text and empties it on the same key (stopping it there), so the key goes on.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') onQueryChange('');
          }}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="pb-finder__input"
        />
        <CommandPalette.ClearButton aria-label={labels.clear} onClick={() => onQueryChange('')} />
      </CommandPalette.SearchField>
      <div className="pb-finder__results" aria-busy={busy}>
        {!empty && (
          <CommandPalette.ListBox aria-label={labels.results}>
            {joined.length > 0 && (
              <CommandPalette.Section id="pb-finder-joined">
                <CommandPalette.SectionHeader>{labels.joined}</CommandPalette.SectionHeader>
                {joined.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </CommandPalette.Section>
            )}
            {others.length > 0 && (
              <CommandPalette.Section id="pb-finder-others">
                <CommandPalette.SectionHeader>{labels.others}</CommandPalette.SectionHeader>
                {others.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </CommandPalette.Section>
            )}
            {lookup && (
              <CommandPalette.Section id="pb-finder-lookup">
                <CommandPalette.SectionHeader>{labels.lookup}</CommandPalette.SectionHeader>
                <CommandPalette.Item
                  // Ids are one namespace across sections and rows: a section and a row sharing one hangs the list.
                  id="pb-finder-lookup-row"
                  textValue={lookup.title}
                  href={lookup.href}
                  closeOnSelect={lookup.href !== undefined}
                  disabled={lookup.pending}
                  onActivate={lookup.href ? undefined : onLookup}
                  className="pb-finder__row"
                >
                  <CommandPalette.ItemIcon>
                    <SearchIcon />
                  </CommandPalette.ItemIcon>
                  <CommandPalette.ItemContent>
                    <CommandPalette.ItemTitle>{lookup.title}</CommandPalette.ItemTitle>
                    <CommandPalette.ItemDescription>{lookup.description}</CommandPalette.ItemDescription>
                  </CommandPalette.ItemContent>
                </CommandPalette.Item>
              </CommandPalette.Section>
            )}
          </CommandPalette.ListBox>
        )}
        {empty && busy && <FinderSkeleton />}
        {empty && status === 'ready' && (
          <CommandPalette.Empty className="pb-finder__state">
            <Text variant="label">{labels.noneTitle}</Text>
            <Text size="sm" color="muted">
              {labels.noneBody}
            </Text>
          </CommandPalette.Empty>
        )}
        {status === 'error' && (
          <div className="pb-finder__state pb-finder__error">
            <Text size="sm">{labels.error}</Text>
            <Button variant="neutral" size="sm" onActivate={onRetry}>
              {labels.retry}
            </Button>
          </div>
        )}
      </div>
      {/* One polite status for the whole panel: the loading line, then how many it shows. */}
      <Text role="status" className="pb-sr">
        {busy && empty ? labels.loading : announcement}
      </Text>
    </CommandPalette.Content>
  );
}

export interface CommunityFinderProps extends FinderPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The header's finder as a popup: Mux CommandPalette, frosted (`translucent`), at full strength from its first frame
 * (Mux's own reduced-motion scope on the backdrop, so neither the panel nor its blur fades in). No trigger part: the
 * shell's link opens it, and the palette's modal returns focus to that link when it closes.
 */
export function CommunityFinder({ open, onOpenChange, ...panel }: CommunityFinderProps) {
  return (
    <CommandPalette.Root open={open} onOpenChange={onOpenChange} className="pb-finder-root">
      <CommandPalette.Backdrop data-muxui-motion="reduced">
        <CommandPalette.Popup aria-label={panel.labels.field} translucent className="pb-finder-popup">
          <FinderPanel {...panel} />
        </CommandPalette.Popup>
      </CommandPalette.Backdrop>
    </CommandPalette.Root>
  );
}
