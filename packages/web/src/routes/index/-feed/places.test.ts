import type { PostView } from '@peblish/schema/views';
import { afterEach, expect, test } from 'vitest';
import type { FeedItem } from './items.ts';
import { firstPlace, forgetPlaces, isHeld, loadNext, readPlace, refreshPlace, revalidatePlace, updateRows, type Batch } from './places.ts';

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

/** A loader that answers each request when the test says, by cursor and in any order. */
function gates() {
  const asked: string[] = [];
  const pending = new Map<string, { resolve: (batch: Batch) => void; reject: (error: Error) => void }[]>();
  const load = (cursor: string) => {
    asked.push(cursor);
    return new Promise<Batch>((resolve, reject) => pending.set(cursor, [...(pending.get(cursor) ?? []), { resolve, reject }]));
  };
  /** The oldest unanswered request for `cursor`. */
  const answer = (cursor: string) => {
    const queue = pending.get(cursor)!;
    const settle = queue.shift()!;
    return settle;
  };
  return { asked, load, answer };
}

const batch = (ids: string[], next: string | null): Batch => ({ items: ids.map(item), next, now: '2026-11-22T11:00:00.000Z' });
const page: Batch = batch(['a', 'b'], 'c1');

/** A kept place of three batches: the page's [a, b], then [c, d] from c1 and [e, f] from c2, and c3 next. */
async function kept(load: (cursor: string) => Promise<Batch>, answer: (cursor: string) => { resolve: (batch: Batch) => void }) {
  loadNext('k', firstPlace(page), load, messages);
  answer('c1').resolve(batch(['c', 'd'], 'c2'));
  await settled();
  loadNext('k', firstPlace(page), load, messages);
  answer('c2').resolve(batch(['e', 'f'], 'c3'));
  await settled();
}

/** The rows the list shows now: a held row keeps its space but is not shown (FeedCards). */
const visible = () => {
  const place = readPlace('k')!;
  return place.rows.filter((row) => !isHeld(place, row)).map((row) => row.post.id);
};

test('back to a kept place, a post removed from batch two never shows while batch one is unchanged', async () => {
  const { asked, load, answer } = gates();
  await kept(load, answer);
  revalidatePlace('k', load);
  refreshPlace('k', page);
  // Until the server answers again, only the page's own batch shows; the others keep their space.
  expect(visible()).toEqual(['a', 'b']);
  expect(readPlace('k')!.rows.map((row) => row.post.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  expect(asked.slice(-2)).toEqual(['c1', 'c2']);
  answer('c1').resolve(batch(['c', 'e'], 'c2'));
  await settled();
  expect(visible()).toEqual(['a', 'b', 'c', 'e']);
  answer('c2').resolve(batch(['f', 'g'], 'c3'));
  await settled();
  expect(visible()).toEqual(['a', 'b', 'c', 'e', 'f', 'g']);
});

test("back to a kept place, a blocked author's post in batch three leaves before batch three shows", async () => {
  const { load, answer } = gates();
  await kept(load, answer);
  loadNext('k', firstPlace(page), load, messages);
  answer('c3').resolve(batch(['blocked', 'h'], null));
  await settled();
  revalidatePlace('k', load);
  answer('c1').resolve(batch(['c', 'd'], 'c2'));
  answer('c2').resolve(batch(['e', 'f'], 'c3'));
  await settled();
  expect(visible()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  answer('c3').resolve(batch(['h'], null));
  await settled();
  expect(visible()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'h']);
  expect(readPlace('k')!.rows.map((row) => row.post.id)).not.toContain('blocked');
});

test('with a reused cursor an older answer never replaces a newer one', async () => {
  const { load, answer } = gates();
  loadNext('k', firstPlace(page), load, messages);
  // The first batch changes, the place is dropped, and the fresh batch's next cursor is the same one.
  const fresh = batch(['new', 'b'], 'c1');
  refreshPlace('k', fresh);
  loadNext('k', firstPlace(fresh), load, messages);
  const older = answer('c1');
  const newer = answer('c1');
  older.resolve(batch(['stale'], 'x'));
  await settled();
  expect(readPlace('k')).toMatchObject({ state: 'pending', next: 'c1' });
  newer.resolve(batch(['current'], 'c2'));
  await settled();
  expect(visible()).toEqual(['new', 'b', 'current']);
});

test('a later batch that fails to answer again is dropped with the ones after it and loads again from its cursor', async () => {
  const { asked, load, answer } = gates();
  await kept(load, answer);
  revalidatePlace('k', load);
  answer('c2').reject(new Error('offline'));
  await settled();
  expect(readPlace('k')!.rows.map((row) => row.post.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(readPlace('k')).toMatchObject({ next: 'c2', state: 'idle' });
  answer('c1').resolve(batch(['c', 'd'], 'c2'));
  await settled();
  loadNext('k', firstPlace(page), load, messages);
  expect(asked.at(-1)).toBe('c2');
});

test('with nothing changed, back to a kept place shows the same rows in the same order, kept in place meanwhile', async () => {
  const { load, answer } = gates();
  await kept(load, answer);
  const before = readPlace('k')!.rows.map((row) => row.post.id);
  revalidatePlace('k', load);
  refreshPlace('k', page);
  expect(readPlace('k')!.rows.map((row) => row.post.id)).toEqual(before);
  answer('c1').resolve(batch(['c', 'd'], 'c2'));
  answer('c2').resolve(batch(['e', 'f'], 'c3'));
  await settled();
  expect(visible()).toEqual(before);
  expect(readPlace('k')).toMatchObject({ next: 'c3', state: 'idle' });
});

test('a visit that ended confirms nothing: its answers come too late, and the next visit asks again', async () => {
  const { asked, load, answer } = gates();
  await kept(load, answer);
  const leave = revalidatePlace('k', load);
  leave();
  answer('c1').resolve(batch(['c', 'd'], 'c2'));
  await settled();
  expect(visible()).toEqual(['a', 'b']);
  revalidatePlace('k', load);
  expect(asked.slice(-4)).toEqual(['c1', 'c2', 'c1', 'c2']);
});
