import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineConsumer } from './consumers.ts';
import { assertJobsRunnable, defineJob, runJobs, type Job } from './jobs.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('job runner', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  test('runs a job at start, then everyMs after each run ends, never two at once, and waits for the last run on abort', async () => {
    const starts: number[] = [];
    let active = 0;
    let most = 0;
    const job = defineJob({
      name: 'slow',
      everyMs: 1_000,
      run: async () => {
        starts.push(Date.now());
        most = Math.max(most, ++active);
        await sleep(500);
        active -= 1;
      },
    });
    const controller = new AbortController();
    let stopped = false;
    const running = runJobs({ signal: controller.signal, jobs: [job] }).then(() => (stopped = true));

    await vi.advanceTimersByTimeAsync(3_100);
    expect(starts).toEqual([0, 1_500, 3_000]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await running;
    expect({ starts: starts.length, most, active }).toEqual({ starts: 3, most: 1, active: 0 });
  });

  test('a run that throws is reported and the job carries on', async () => {
    const failure = new Error('peer unreachable');
    let runs = 0;
    const job = defineJob({
      name: 'flaky',
      everyMs: 1_000,
      run: async () => {
        runs += 1;
        if (runs === 1) throw failure;
      },
    });
    const onError = vi.fn();
    const controller = new AbortController();
    const running = runJobs({ signal: controller.signal, jobs: [job], onError });

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await running;
    expect(onError.mock.calls).toEqual([[job, failure]]);
    expect(runs).toBe(2);
  });

  test('the stop reaches a run through its signal, and the abort it throws is not reported', async () => {
    const job = defineJob({
      name: 'waits',
      everyMs: 1_000,
      run: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    });
    const onError = vi.fn();
    const controller = new AbortController();
    const running = runJobs({ signal: controller.signal, jobs: [job], onError });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await running;
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('job names and intervals', () => {
  const job = (name: string): Job => defineJob({ name, everyMs: 1_000, run: async () => {} });
  const consumer = defineConsumer({ name: 'search-index', events: ['post.created'], startAt: 'beginning', handle: async () => {} });

  test('a name shared by two jobs, or by a job and a consumer, is refused before anything runs', async () => {
    expect(() => assertJobsRunnable([job('prune'), job('prune')])).toThrow('two jobs are named prune; job names must be unique');
    expect(() => assertJobsRunnable([job('search-index')], [consumer])).toThrow(
      'job search-index has the name of an outbox consumer; names must be unique across both',
    );
    await expect(runJobs({ signal: new AbortController().signal, jobs: [job('prune'), job('prune')] })).rejects.toThrow(
      'two jobs are named prune',
    );
    expect(() => assertJobsRunnable([job('prune'), job('refetch')], [consumer])).not.toThrow();
  });

  test('defineJob refuses an interval setTimeout cannot hold', () => {
    for (const everyMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => defineJob({ name: 'bad', everyMs, run: async () => {} })).toThrow(RangeError);
    }
    expect(defineJob({ name: 'daily', everyMs: 86_400_000, run: async () => {} }).everyMs).toBe(86_400_000);
  });
});
