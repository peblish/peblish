import { type } from 'arktype';

// How a thread is ordered. Pure (no database), so the page can import the sort names. A thread
// is displayed depth first, and a sort only decides the order among siblings; the order itself
// is SQL (siblings.ts), so a page of siblings is chosen in it before the limit. Adding a sort is
// a name in `threadSorts` and a case in siblings.ts.

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
