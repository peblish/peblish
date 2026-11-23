// Where the reader left a feed's list, by history entry (the router's key for it): the row they opened a post from
// in this tab and how far it stood from the window's top, and the window's scroll. A return to the entry
// puts that row back where it stood once the fresh rows are drawn (feed-page.tsx), so posts added, removed or
// ranked anew above it do not move what the reader comes back to; when that row is not among the fresh rows
// (removed, withheld, past `n` now) or they left another way, the window goes back to the scroll it had. Rows are
// never kept here. In session storage, so a return to the entry after a reload elsewhere finds it too.

/** `post` names the row (its post), not the page opened from it. */
export type Place = { y: number; post?: string | undefined; offset?: number | undefined };

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

/** The reader leaves the entry `entry` from this place. */
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

/** The place the reader left `entry` from, once: a later arrival at it has its own. */
export function takePlace(entry: string): Place | undefined {
  const all = load();
  const place = all.get(entry);
  if (place) {
    all.delete(entry);
    save(all);
  }
  return place;
}
