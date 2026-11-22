import type { FeedItem } from './items.ts';

// A list's place for the visit (Commons' "keep place"): the rows it has loaded by itself and whether
// it is loading more. Kept in memory only, never in sessionStorage or the history entry, since the rows
// were read for one viewer; a page load starts again. The key names the viewer, the history entry and
// the list, so Back and Forward find the place again, while a fresh visit to the same address (a new
// history entry) starts at the first batch. The router puts the scroll position back itself, once the
// rows are there again. The page's data (the first batch) is the truth for the rows it holds: when a
// fresh copy of it comes (Back reloads it in the background), refreshPlace takes it.

/** A row and the clock its age prints against (the server's, for the batch it came with). */
export type PlaceRow = FeedItem & { now: string };

export interface Place {
  rows: readonly PlaceRow[];
  /** The posts of the first batch, the page's own data: what a fresh copy of that data is compared with. */
  first: readonly string[];
  /** The cursor of the next batch; null at the end. */
  next: string | null;
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
  state: 'idle',
  said: '',
});

/**
 * Loads the batch after the place's last one and appends it, leaving out a post already in the list
 * (a ranking can move a post across a cursor). It runs here, outside the list: a batch still loading
 * when the reader opens a post lands anyway, and Back finds it. Nothing happens while a batch loads or
 * once the list has ended. A batch lands only on the place that asked for it: one that refreshPlace
 * dropped meanwhile, or that started again from fresh data, waits for a cursor of its own.
 */
export function loadNext(key: string, from: Place, load: (cursor: string) => Promise<Batch>, messages: PlaceMessages): void {
  const current = places.get(key) ?? from;
  if (current.state === 'pending' || current.next === null) return;
  const cursor = current.next;
  write(key, { ...current, state: 'pending', said: '' });
  load(cursor).then(
    (batch) => {
      const now = places.get(key);
      if (now?.state !== 'pending' || now.next !== cursor) return;
      const seen = new Set(now.rows.map((row) => row.post.id));
      const added = batch.items.filter((item) => !seen.has(item.post.id)).map((item) => ({ ...item, now: batch.now }));
      write(key, {
        ...now,
        rows: [...now.rows, ...added],
        next: batch.next,
        state: 'idle',
        said: messages.loaded(added.length, batch.next === null),
      });
    },
    () => {
      const now = places.get(key);
      if (now?.state === 'pending' && now.next === cursor) write(key, { ...now, state: 'failed', said: messages.failed });
    },
  );
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
