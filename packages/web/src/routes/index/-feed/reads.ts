import type { FeedPosition } from './search.ts';

// The reads of a feed's list in this browser, by list (its path, sort, period and first cursor), as the route's
// loader starts and ends them: a list draws none of its rows while its own read is out, nor until the answer of
// the newest one that landed is the list's data (feed-page.tsx), so a return to it (Back, Forward, a link) never
// shows a row from before, whatever the timing. And the list's own growth of `n` (it loads more, then says so in
// its address), the one navigation of its entry that reads nothing again (route.ts).

const listOf = (path: string, { sort, period, cursor }: FeedPosition) => `${path} ${sort} ${period} ${cursor ?? ''}`;

/** A list's reads: how many are out, and when the newest one that landed was asked for (votes.ts's clock). */
type Reads = { out: number; landed: number };

/** Replaced, never changed, on each start and end. */
let reads: ReadonlyMap<string, Reads> = new Map();
const listeners = new Set<() => void>();
const set = (list: string, value: Reads) => {
  reads = new Map(reads).set(list, value);
  for (const listener of listeners) listener();
};

/**
 * A read of a list, asked for at `asked`, starts; call what it returns when it ends, saying whether its answer
 * landed (it becomes the list's data). Nothing on the server.
 */
export function startRead(path: string, position: FeedPosition, asked: number): (landed: boolean) => void {
  if (typeof window === 'undefined') return () => {};
  const list = listOf(path, position);
  const at = (now = reads.get(list)) => now ?? { out: 0, landed: 0 };
  set(list, { ...at(), out: at().out + 1 });
  let ended = false;
  return (landed) => {
    if (ended) return;
    ended = true;
    const now = at();
    set(list, { out: now.out - 1, landed: landed ? Math.max(now.landed, asked) : now.landed });
  };
}

export function subscribeReads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The reads so far, for useSyncExternalStore. */
export const readsNow = (): ReadonlyMap<string, Reads> => reads;
const none: ReadonlyMap<string, Reads> = new Map();
/** None, as the server renders a list. */
export const noReads = (): ReadonlyMap<string, Reads> => none;

/** Whether a list holding data asked for at `asked` waits for a read: one is out, or a newer one landed. */
export function isReading(reads: ReadonlyMap<string, Reads>, path: string, position: FeedPosition, asked: number) {
  const list = reads.get(listOf(path, position));
  return list !== undefined && (list.out > 0 || list.landed > asked);
}

let growth: string | null = null;

/** The list is about to say in its address that it holds `n` rows; until what this returns is called, that navigation reads nothing. */
export function grow(path: string, position: FeedPosition, n: number): () => void {
  const mark = `${listOf(path, position)} ${n}`;
  growth = mark;
  return () => {
    if (growth === mark) growth = null;
  };
}

export const isGrowth = (path: string, position: FeedPosition, n: number) => growth === `${listOf(path, position)} ${n}`;
