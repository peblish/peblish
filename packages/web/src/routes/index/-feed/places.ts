import type { FeedItem } from './items.ts';

// A list's place for the visit (Commons' "keep place"): the rows it has loaded by itself and whether
// it is loading more. Kept in memory only, never in sessionStorage or the history entry, since the rows
// were read for one viewer; a page load starts again. The key names the viewer, the history entry and
// the list, so Back and Forward find the place again, while a fresh visit to the same address (a new
// history entry) starts at the first batch. The router puts the scroll position back itself, once the
// rows are there again. The page's data (the first batch) is the truth for the rows it holds: when a
// fresh copy of it comes (Back reloads it in the background), refreshPlace takes it. A later batch is
// shown from memory only once the server has confirmed it since the reader came back (revalidatePlace).

/**
 * A row and the clock its age prints against (the server's, for the batch it came with); `batch` is the
 * cursor a later batch was asked with, absent for the first batch (the page's own data).
 */
export type PlaceRow = FeedItem & { now: string; batch?: string };

/** One request for a batch: an answer lands only while its ask is still the place's, so a newer ask for the same cursor wins. */
type Ask = { readonly cursor: string };

export interface Place {
  rows: readonly PlaceRow[];
  /** The posts of the first batch, the page's own data: what a fresh copy of that data is compared with. */
  first: readonly string[];
  /** The cursor of the next batch; null at the end. */
  next: string | null;
  /** The cursors the later batches were asked with, in order. */
  batches: readonly string[];
  /** Later batches held back since the reader came back, each with the ask that may confirm it: their rows keep their space, unseen. */
  held: ReadonlyMap<string, Ask>;
  /** The ask for the next batch, while it is pending. */
  asked: Ask | null;
  state: 'idle' | 'pending' | 'failed';
  /** What the list's status last said: once per batch, emptied while the next one loads. */
  said: string;
}

/** The next batch, as the list's loader answers it. */
export interface Batch {
  items: readonly FeedItem[];
  next: string | null;
  now: string;
}

export interface PlaceMessages {
  /** "20 more posts loaded." and, at the end, what the end line says. */
  loaded: (count: number, end: boolean) => string;
  failed: string;
}

/** How many places a visit keeps: the oldest goes first. */
const kept = 30;
const places = new Map<string, Place>();
const listeners = new Set<() => void>();

function write(key: string, place: Place) {
  places.delete(key);
  places.set(key, place);
  for (const old of places.keys()) {
    if (places.size <= kept) break;
    places.delete(old);
  }
  for (const listener of listeners) listener();
}

export function subscribePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const readPlace = (key: string): Place | undefined => places.get(key);

/** A list's place as its page's data has it: one batch, nothing loading. */
export const firstPlace = (batch: Batch): Place => ({
  rows: batch.items.map((item) => ({ ...item, now: batch.now })),
  first: batch.items.map((item) => item.post.id),
  next: batch.next,
  batches: [],
  held: new Map(),
  asked: null,
  state: 'idle',
  said: '',
});

/** Whether a row waits for the server to confirm it: the list keeps its space but does not show it. */
export const isHeld = (place: Place, row: PlaceRow): boolean => row.batch !== undefined && place.held.has(row.batch);

/**
 * Loads the batch after the place's last one and appends it, leaving out a post already in the list
 * (a ranking can move a post across a cursor). It runs here, outside the list: a batch still loading
 * when the reader opens a post lands anyway, and Back finds it. Nothing happens while a batch loads or
 * once the list has ended. A batch lands only on the ask that is still the place's: an answer for a place
 * that refreshPlace dropped meanwhile, or for an earlier ask with the same cursor, is left out.
 */
export function loadNext(key: string, from: Place, load: (cursor: string) => Promise<Batch>, messages: PlaceMessages): void {
  const current = places.get(key) ?? from;
  if (current.state === 'pending' || current.next === null) return;
  const cursor = current.next;
  const ask: Ask = { cursor };
  write(key, { ...current, state: 'pending', asked: ask, said: '' });
  load(cursor).then(
    (batch) => {
      const now = places.get(key);
      if (now?.asked !== ask) return;
      const seen = new Set(now.rows.map((row) => row.post.id));
      const added = batch.items.filter((item) => !seen.has(item.post.id)).map((item) => ({ ...item, now: batch.now, batch: cursor }));
      write(key, {
        ...now,
        rows: [...now.rows, ...added],
        batches: [...now.batches, cursor],
        next: batch.next,
        state: 'idle',
        asked: null,
        said: messages.loaded(added.length, batch.next === null),
      });
    },
    () => {
      const now = places.get(key);
      if (now?.asked === ask) write(key, { ...now, state: 'failed', asked: null, said: messages.failed });
    },
  );
}

/**
 * The reader came back to a kept place (Back or Forward mounted its list again): every later batch is held,
 * its rows keeping their space so the router's scroll position still fits, and is asked for again with its
 * own cursor. Each answer is the truth for its batch: its posts take their rows' place, a post it no longer
 * holds (removed, or by an author blocked since) leaves, and a post it moved up from a later batch is shown
 * once, in the earlier one. A batch that fails is dropped with the ones after it, and the list loads from its
 * cursor again. The first batch is the page's data, which refreshPlace takes. The returned function ends the
 * visit's asks: an answer that comes after it confirms nothing, and the rows stay held for the next visit.
 */
export function revalidatePlace(key: string, load: (cursor: string) => Promise<Batch>): () => void {
  const place = places.get(key);
  if (!place || place.batches.length === 0) return () => {};
  const asks = new Map(place.batches.map((cursor): [string, Ask] => [cursor, { cursor }]));
  write(key, { ...place, held: asks });
  for (const ask of asks.values())
    load(ask.cursor).then(
      (batch) => confirmBatch(key, ask, batch),
      () => dropFrom(key, ask),
    );
  return () => {
    const now = places.get(key);
    if (!now || ![...asks.values()].some((ask) => now.held.get(ask.cursor) === ask)) return;
    write(key, {
      ...now,
      held: new Map([...now.held].map(([cursor, ask]): [string, Ask] => [cursor, asks.get(cursor) === ask ? { cursor } : ask])),
    });
  };
}

function confirmBatch(key: string, ask: Ask, batch: Batch): void {
  const place = places.get(key);
  if (place?.held.get(ask.cursor) !== ask) return;
  // Each row's batch in list order: 0 for the first, then the later ones as they were asked.
  const rank = (row: PlaceRow) => (row.batch === undefined ? 0 : place.batches.indexOf(row.batch) + 1);
  const at = place.batches.indexOf(ask.cursor) + 1;
  const before = place.rows.filter((row) => rank(row) < at);
  const shown = new Set(before.map((row) => row.post.id));
  const fresh = batch.items.filter((item) => !shown.has(item.post.id)).map((item) => ({ ...item, now: batch.now, batch: ask.cursor }));
  const taken = new Set(fresh.map((row) => row.post.id));
  const held = new Map(place.held);
  held.delete(ask.cursor);
  const last = at === place.batches.length && place.state !== 'pending';
  write(key, {
    ...place,
    rows: [...before, ...fresh, ...place.rows.filter((row) => rank(row) > at && !taken.has(row.post.id))],
    held,
    ...(last ? { next: batch.next } : {}),
  });
}

function dropFrom(key: string, ask: Ask): void {
  const place = places.get(key);
  if (place?.held.get(ask.cursor) !== ask) return;
  const batches = place.batches.slice(0, place.batches.indexOf(ask.cursor));
  const kept = new Set(batches);
  write(key, {
    ...place,
    rows: place.rows.filter((row) => row.batch === undefined || kept.has(row.batch)),
    batches,
    held: new Map([...place.held].filter(([cursor]) => kept.has(cursor))),
    next: ask.cursor,
    state: 'idle',
    asked: null,
    said: '',
  });
}

/**
 * Changes the kept rows of one post (a vote that was saved, the post as a fresher page has it), so Back
 * shows it as it is now. A place that was never kept is left alone: it renders the page's own data.
 */
export function updateRows(key: string, postId: string, change: (row: PlaceRow) => PlaceRow): void {
  const place = places.get(key);
  if (!place?.rows.some((row) => row.post.id === postId)) return;
  write(key, { ...place, rows: place.rows.map((row) => (row.post.id === postId ? change(row) : row)) });
}

/**
 * Takes a fresh copy of the page's data (the first batch) into a kept place. With the same posts as
 * before, each row takes its post as it is now (a vote cast on the post's own page, a new comment count)
 * and keeps its place, so the later batches and the scroll position stay. With other posts (one was
 * removed, its author blocked, a new one came in) the place is dropped: the list shows the fresh batch
 * and loads the next ones again by itself, so no row the server no longer sends stays on the page. The
 * cursor is not compared: it carries the clock of the read, so every fresh copy has another one.
 */
export function refreshPlace(key: string, batch: Batch): void {
  const place = places.get(key);
  if (!place) return;
  const fresh = new Map(batch.items.map((item) => [item.post.id, item]));
  if (fresh.size !== place.first.length || place.first.some((id) => !fresh.has(id))) {
    places.delete(key);
    for (const listener of listeners) listener();
    return;
  }
  write(key, {
    ...place,
    rows: place.rows.map((row) => {
      const item = fresh.get(row.post.id);
      return item ? { ...row, post: item.post, thumbnailSrc: item.thumbnailSrc } : row;
    }),
  });
}

/** For tests: forget every place. */
export function forgetPlaces(): void {
  places.clear();
}
