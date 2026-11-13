import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deadlineBody, PublicBodyLate } from './stream.ts';

// The server (srvx) reads the next chunk only once the previous one was written to the socket,
// and destroys the socket when a read rejects. These tests read the same way: a stalled reader is
// a socket the edge is not draining.

const bytes = new Uint8Array(200 * 1024).map((_, i) => i % 251);
let at = 0;
const clock = () => at;

beforeEach(() => {
  vi.useFakeTimers();
  at = 0;
});
afterEach(() => vi.useRealTimers());

const later = (ms: number) => {
  at += ms;
  vi.advanceTimersByTime(ms);
};

test('a reader that keeps up gets every byte, and the stream closes only after the last chunk was taken', async () => {
  const reader = deadlineBody(bytes, 10_000, { clock, chunk: 64 * 1024 }).getReader();
  const got: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got.push(...value);
    later(1_000);
  }
  expect(got).toEqual([...bytes]);
});

test('a stalled reader is cut off at the deadline: the next read rejects, so the server destroys the socket (round 3, item 2)', async () => {
  const reader = deadlineBody(bytes, 10_000, { clock, chunk: 64 * 1024 }).getReader();
  const first = await reader.read();
  expect(first.value?.byteLength).toBe(64 * 1024);
  // The edge stops draining; the deadline passes.
  later(10_001);
  await expect(reader.read()).rejects.toBeInstanceOf(PublicBodyLate);
});

test('a reader that took the last chunk but resumes after the deadline is cut off too: closing needs one more pull in time', async () => {
  const reader = deadlineBody(bytes, 10_000, { clock, chunk: 256 * 1024 }).getReader();
  expect((await reader.read()).value?.byteLength).toBe(bytes.byteLength);
  // A paused process: no timer ran, but the clock moved on.
  at += 20_000;
  await expect(reader.read()).rejects.toBeInstanceOf(PublicBodyLate);
});
