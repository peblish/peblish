import { type } from 'arktype';

// How a thread is ordered. Pure (no database), so the page can import the sort names. A thread
// is displayed depth first, and a sort only decides the order among siblings; adding one is a
// name in `threadSorts` and a case in `compareSiblings`.

/** The plan's sort set. The mock also shows Controversial, which is outside it. */
export const threadSorts = ['hot', 'top', 'new', 'old'] as const;
export type ThreadSort = (typeof threadSorts)[number];

/** The sort a thread has when the page names none (Lemmy's default). */
export const defaultThreadSort: ThreadSort = 'hot';

/** The `sort` search parameter. */
export const ThreadSortParam = type.enumerated(...threadSorts);

/** A raw `sort` value as a sort: anything that is not one of the four is the default, never an error page. */
export function parseSort(value: unknown): ThreadSort {
  const sort = ThreadSortParam(value);
  return sort instanceof type.errors ? defaultThreadSort : sort;
}

/** What ordering reads of a comment. */
export type Sortable = { id: string; upvotes: number; downvotes: number; publishedAt: Date };

const score = (comment: Sortable) => comment.upvotes - comment.downvotes;

/** Lemmy's hot rank: the score's logarithm over the age in hours (plus 2) to the power 1.8. */
export function hotRank(comment: Sortable, now: Date): number {
  const hours = Math.max(0, now.getTime() - comment.publishedAt.getTime()) / 3_600_000;
  return (10_000 * Math.log10(Math.max(1, score(comment) + 3))) / (hours + 2) ** 1.8;
}

/** Newest first, then by id, so equal timestamps still have one order. */
const newest = (a: Sortable, b: Sortable) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The comparator for siblings under one sort. `now` fixes the clock for Hot, so a test can pin it. */
export function compareSiblings(sort: ThreadSort, now: Date): (a: Sortable, b: Sortable) => number {
  switch (sort) {
    case 'hot':
      return (a, b) => hotRank(b, now) - hotRank(a, now) || newest(a, b);
    case 'top':
      return (a, b) => score(b) - score(a) || newest(a, b);
    case 'new':
      return newest;
    case 'old':
      return (a, b) => -newest(a, b);
  }
}

/**
 * Rows in display order: depth first, siblings sorted. Rows whose parent is not in `rows` are
 * the roots (the top-level comments, or the comment a permalink page starts from). Rows that
 * hang from a missing parent stay in as roots too, so nothing is lost silently.
 */
export function inDisplayOrder<T extends Sortable & { parentId: string | null }>(rows: readonly T[], sort: ThreadSort, now: Date): T[] {
  const compare = compareSiblings(sort, now);
  const present = new Set(rows.map((row) => row.id));
  const children = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = row.parentId !== null && present.has(row.parentId) ? row.parentId : null;
    const siblings = children.get(key);
    if (siblings) siblings.push(row);
    else children.set(key, [row]);
  }
  const ordered: T[] = [];
  // An explicit stack: a chain 50 deep is fine for recursion, but nothing here depends on that.
  const stack = [...(children.get(null) ?? [])].sort(compare).reverse();
  for (let row = stack.pop(); row; row = stack.pop()) {
    ordered.push(row);
    const below = children.get(row.id);
    if (below) stack.push(...[...below].sort(compare).reverse());
  }
  return ordered;
}
