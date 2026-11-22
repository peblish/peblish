import type { PostView } from '@peblish/schema/views';
import { afterEach, expect, test } from 'vitest';
import type { FeedItem } from './items.ts';
import { firstPlace, forgetPlaces, loadNext, readPlace, refreshPlace, updateRows, type Batch } from './places.ts';

afterEach(forgetPlaces);

const item = (id: string): FeedItem => ({ post: { id, title: `Post ${id}` } as PostView, thumbnailSrc: null });
const messages = { loaded: (count: number, end: boolean) => `${count}${end ? ' end' : ''}`, failed: 'failed' };
const first = firstPlace({ items: [item('a'), item('b')], next: 'c1', now: '2026-11-22T10:00:00.000Z' });

/** A loader whose answer the test gives, so what happens while a batch is pending can be seen. */
function gate() {
  const asked: string[] = [];
  let settle: { resolve: (batch: Batch) => void; reject: (error: Error) => void } | undefined;
  const load = (cursor: string) => {
    asked.push(cursor);
    return new Promise<Batch>((resolve, reject) => (settle = { resolve, reject }));
  };
  return { asked, load, settle: () => settle! };
}

test('a batch appends once, leaves out a post already shown, and says what loaded', async () => {
  const { asked, load, settle } = gate();
  loadNext('k', first, load, messages);
  loadNext('k', first, load, messages);
  expect(asked).toEqual(['c1']);
  expect(readPlace('k')).toMatchObject({ state: 'pending', said: '' });
  settle().resolve({ items: [item('b'), item('c')], next: null, now: '2026-11-22T10:05:00.000Z' });
  await Promise.resolve();
  await Promise.resolve();
  const place = readPlace('k')!;
  expect(place.rows.map((row) => row.post.id)).toEqual(['a', 'b', 'c']);
  expect(place.rows.map((row) => row.now)).toEqual(['2026-11-22T10:00:00.000Z', '2026-11-22T10:00:00.000Z', '2026-11-22T10:05:00.000Z']);
  expect(place).toMatchObject({ next: null, state: 'idle', said: '1 end' });
  // At the end nothing more is asked for.
  loadNext('k', first, load, messages);
  expect(asked).toEqual(['c1']);
});

test('a failed batch keeps the rows and the cursor, so Retry asks for the same batch', async () => {
  const { asked, load, settle } = gate();
  loadNext('k', first, load, messages);
  settle().reject(new Error('offline'));
  await Promise.resolve();
  await Promise.resolve();
  expect(readPlace('k')).toMatchObject({ next: 'c1', state: 'failed', said: 'failed' });
  expect(readPlace('k')!.rows).toHaveLength(2);
  loadNext('k', first, load, messages);
  expect(asked).toEqual(['c1', 'c1']);
});

test('a kept post can be changed in place, and a place never kept is left alone', async () => {
  const { load, settle } = gate();
  loadNext('k', first, load, messages);
  settle().resolve({ items: [item('c')], next: 'c2', now: '2026-11-22T10:05:00.000Z' });
  await Promise.resolve();
  await Promise.resolve();
  updateRows('k', 'c', (row) => ({ ...row, post: { ...row.post, myVote: 1 } }));
  expect(readPlace('k')!.rows.find((row) => row.post.id === 'c')!.post.myVote).toBe(1);
  updateRows('other', 'c', (row) => row);
  expect(readPlace('other')).toBeUndefined();
});

test('places are kept apart by key', () => {
  const { load } = gate();
  loadNext('one', first, load, messages);
  expect(readPlace('one')?.state).toBe('pending');
  expect(readPlace('two')).toBeUndefined();
});

/** Lets the loader's answer reach the place. */
const settled = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** The rows the list shows for `key`: the kept place, or the page's data where none is kept (FeedCards). */
const shown = (key: string, data: Batch) => (readPlace(key) ?? firstPlace(data)).rows.map((row) => row.post.id);

/** A place with three batches: the page's own [removed, kept], then [b1] and [b2], loaded by themselves. */
async function threeBatches() {
  const { load, settle } = gate();
  const page: Batch = { items: [item('removed'), item('kept')], next: 'c1', now: '2026-11-22T10:00:00.000Z' };
  loadNext('k', firstPlace(page), load, messages);
  settle().resolve({ items: [item('b1')], next: 'c2', now: '2026-11-22T10:01:00.000Z' });
  await settled();
  loadNext('k', firstPlace(page), load, messages);
  settle().resolve({ items: [item('b2')], next: 'c3', now: '2026-11-22T10:02:00.000Z' });
  await settled();
  expect(shown('k', page)).toEqual(['removed', 'kept', 'b1', 'b2']);
}

test('a fresh first batch with other posts is the truth: a removed post leaves, a new one enters', async () => {
  await threeBatches();
  // Back: the loader answers the first batch again, without the removed post and with a new one.
  const fresh: Batch = { items: [item('new'), item('kept')], next: 'd1', now: '2026-11-22T10:10:00.000Z' };
  refreshPlace('k', fresh);
  expect(shown('k', fresh)).toEqual(['new', 'kept']);
  expect(readPlace('k')).toBeUndefined();
});

test('a batch still loading when the place is dropped never lands on the fresh one', async () => {
  const { asked, load, settle } = gate();
  const page = firstPlace({ items: [item('removed'), item('kept')], next: 'c1', now: '2026-11-22T10:00:00.000Z' });
  loadNext('k', page, load, messages);
  const old = settle();
  const fresh: Batch = { items: [item('new'), item('kept')], next: 'd1', now: '2026-11-22T10:10:00.000Z' };
  refreshPlace('k', fresh);
  // The list, now on the fresh batch, asks for its own next one before the old answer comes.
  loadNext('k', firstPlace(fresh), load, messages);
  expect(asked).toEqual(['c1', 'd1']);
  old.resolve({ items: [item('stale')], next: 'c2', now: '2026-11-22T10:01:00.000Z' });
  await settled();
  expect(readPlace('k')).toMatchObject({ next: 'd1', state: 'pending' });
  expect(shown('k', fresh)).toEqual(['new', 'kept']);
});

test('a fresh first batch with the same posts keeps every batch and takes the posts as they are now', async () => {
  await threeBatches();
  const before = readPlace('k')!;
  const voted = { ...item('kept'), post: { ...item('kept').post, myVote: 1 as const } };
  refreshPlace('k', { items: [voted, item('removed')], next: 'd1', now: '2026-11-22T10:10:00.000Z' });
  const after = readPlace('k')!;
  expect(after.rows.map((row) => row.post.id)).toEqual(['removed', 'kept', 'b1', 'b2']);
  expect(after.rows.map((row) => row.now)).toEqual(before.rows.map((row) => row.now));
  expect(after).toMatchObject({ next: 'c3', state: 'idle' });
  expect(after.rows[1]!.post.myVote).toBe(1);
});
