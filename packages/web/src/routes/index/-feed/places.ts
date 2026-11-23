// Where the reader left a feed's list for a post they opened from one of its rows, by history entry (the router's
// key for it): that row and how far it stood from the window's top. A return to the entry through the router puts
// that row back where it stood once the fresh rows are drawn (feed-page.tsx), so posts added, removed or ranked anew
// above it do not move what the reader comes back to. Nothing else is kept, and nothing else moves the window: any
// other way off the list, a row not among the fresh rows, a document's first render (a reload, a first visit, a
// return from another document) and a reader who scrolls on the way back leave it to the router and the browser.
// Rows are never kept here. In session storage, so a return through the router after a reload elsewhere (the post
// opened) finds it too.

/** `post` names the row (its post), not the page opened from it. */
export type Place = { post: string; offset: number };

const storageKey = 'peblish.feed-places';
/** A reader goes back this many entries at most; the oldest is let go past it. */
const kept = 50;

let places: Map<string, Place> | null = null;

function load(): Map<string, Place> {
  if (places) return places;
  try {
    places = new Map(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as [string, Place][]);
  } catch {
    places = new Map();
  }
  return places;
}

function save(all: Map<string, Place>) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...all]));
  } catch {
    // Storage full or blocked: the place lasts while this page does.
  }
}

/** The reader leaves the entry `entry` for a post opened from this place. */
export function keepPlace(entry: string, place: Place): void {
  const all = load();
  all.delete(entry);
  all.set(entry, place);
  for (const old of all.keys()) {
    if (all.size <= kept) break;
    all.delete(old);
  }
  save(all);
}

/** The reader leaves the entry `entry` another way: no place from an earlier leave stays for it. */
export function dropPlace(entry: string): void {
  const all = load();
  if (all.delete(entry)) save(all);
}

/** The place the reader left `entry` from, once: a later arrival at it has its own, or none. */
export function takePlace(entry: string): Place | undefined {
  const all = load();
  const place = all.get(entry);
  if (place) {
    all.delete(entry);
    save(all);
  }
  return place;
}

// The reader's own scrolling (the wheel, a touch moving, a key that scrolls) and the last traversal of history
// (Back, Forward), in this document: a return the reader scrolls on its way is left to the router.
let traversedAt = 0;
let scrolledAt = -1;
const scrollKeys = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);
if (typeof window !== 'undefined') {
  const scrolled = () => (scrolledAt = performance.now());
  addEventListener('popstate', () => (traversedAt = performance.now()), true);
  addEventListener('wheel', scrolled, { capture: true, passive: true });
  addEventListener('touchmove', scrolled, { capture: true, passive: true });
  addEventListener(
    'keydown',
    (event) => {
      const field =
        event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (scrollKeys.has(event.key) && !field) scrolled();
    },
    true,
  );
}

/** Whether the reader has scrolled since the last Back or Forward. */
export const scrolledSinceTraversal = () => scrolledAt > traversedAt;
