import type { PostView } from '@peblish/schema/views';
import { afterEach, expect, test } from 'vitest';
import type { FeedItem } from './items.ts';
import { firstPlace, forgetPlaces, loadNext, readPlace, type Batch } from './places.ts';

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

test('places are kept apart by key', () => {
  const { load } = gate();
  loadNext('one', first, load, messages);
  expect(readPlace('one')?.state).toBe('pending');
  expect(readPlace('two')).toBeUndefined();
});
