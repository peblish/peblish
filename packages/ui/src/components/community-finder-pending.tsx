import { SkelCircle, SkelLine } from '../skeleton/shape.tsx';
import { SearchIcon } from './icons.tsx';
import { Text } from './text.tsx';

// Apart from community-finder.tsx, so a page shows the finder loading without loading Mux's CommandPalette.

/** Rows that stand in for the first answer: no motion, hidden from assistive technology (the status says it). */
export function FinderSkeleton() {
  return (
    <div className="pb-finder__skeleton" aria-hidden="true">
      {[70, 50, 60, 40].map((width) => (
        <div key={width} className="pb-finder__skeleton-row">
          <SkelCircle size="sm" />
          <div className="pb-finder__skeleton-text">
            <SkelLine kind="label" width={width === 70 ? 50 : 40} />
            <SkelLine kind="meta" width={width === 70 ? 70 : 60} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The finder as it opens while its code is still on the way (shell/header.tsx): over the page where its popup will
 * be, its field's place and skeleton rows, and a status that says it is loading. Nothing in it takes focus or a
 * press; the finder replaces it, its field focused, once loaded.
 */
export function FinderPending({ label, loading, top }: { label: string; loading: string; top?: number }) {
  return (
    <div className="pb-finder-pending" style={top === undefined ? undefined : { '--pb-finder-top': top }}>
      <div className="pb-finder-pending__popup" aria-hidden="true">
        <div className="pb-finder-pending__field">
          <SearchIcon className="pb-finder__field-icon" />
          <Text size="sm" color="muted">
            {label}
          </Text>
        </div>
        <div className="pb-finder__results">
          <FinderSkeleton />
        </div>
      </div>
      <Text role="status" className="pb-sr">
        {loading}
      </Text>
    </div>
  );
}
