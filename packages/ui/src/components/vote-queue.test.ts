import { expect, test } from 'vitest';
import { createVoteQueue, type Vote } from './vote-queue.ts';

/** A saver the test settles by hand: `calls` lists the votes sent, `settle(i, error?)` ends the i-th. */
function manualSaver() {
  const calls: Vote[] = [];
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  return {
    calls,
    save: (value: Vote) => {
      calls.push(value);
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
    },
    async settle(index: number, error?: Error) {
      if (error) pending[index]?.reject(error);
      else pending[index]?.resolve();
      // Let the queue's continuation run (and send the next request, if any).
      await new Promise((resolve) => setTimeout(resolve));
    },
  };
}

function setup(initial: Vote = 0) {
  const saver = manualSaver();
  const shown: Vote[] = [];
  const inner = createVoteQueue({ initial, onChange: (value) => shown.push(value) });
  const queue = { press: (arrow: 1 | -1) => inner.press(arrow, saver.save), sync: inner.sync };
  return { ...saver, queue, shown, now: () => shown.at(-1) };
}

test('one request is in flight at a time: a second choice waits for the first to settle', async () => {
  const { queue, calls, settle, now } = setup();
  queue.press(1);
  queue.press(-1);
  expect(now()).toBe(-1);
  expect(calls).toEqual([1]);
  await settle(0);
  expect(calls).toEqual([1, -1]);
  await settle(1);
  expect(now()).toBe(-1);
});

test('only the newest choice is sent after the pending save', async () => {
  const { queue, calls, settle } = setup();
  queue.press(1);
  queue.press(-1);
  queue.press(1);
  await settle(0);
  // Up, down, up while the first up was in flight: the server already holds up.
  expect(calls).toEqual([1]);
});

test('taking a vote back while it is being saved sends the take-back after it', async () => {
  const { queue, calls, settle, now } = setup();
  queue.press(1);
  queue.press(1);
  expect(now()).toBe(0);
  await settle(0);
  expect(calls).toEqual([1, 0]);
  await settle(1);
  expect(now()).toBe(0);
});

test('a refusal that settles after a newer choice does not undo it', async () => {
  const { queue, calls, settle, now } = setup();
  queue.press(1);
  queue.press(-1);
  await settle(0, new Error('refused'));
  // The refused up is skipped over; the newer down is sent and holds.
  expect(calls).toEqual([1, -1]);
  await settle(1);
  expect(now()).toBe(-1);
});

test('a refusal goes back to the last vote the server holds, not to the one pressed before', async () => {
  const { queue, calls, settle, now } = setup();
  queue.press(1);
  await settle(0);
  queue.press(1); // take it back
  expect(now()).toBe(0);
  await settle(1, new Error('refused'));
  expect(calls).toEqual([1, 0]);
  expect(now()).toBe(1);
});

test('a refusal with nothing newer goes back to the starting vote', async () => {
  const { queue, settle, now } = setup(-1);
  queue.press(1);
  expect(now()).toBe(1);
  await settle(0, new Error('refused'));
  expect(now()).toBe(-1);
});

test('a value from the server replaces the optimistic one only when nothing is being saved', async () => {
  const { queue, settle, now } = setup();
  queue.press(1);
  queue.sync(0);
  expect(now()).toBe(1);
  await settle(0);
  expect(now()).toBe(1);
  queue.sync(-1);
  expect(now()).toBe(-1);
});
