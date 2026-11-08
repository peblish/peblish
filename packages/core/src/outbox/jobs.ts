import type { Consumer } from './consumers.ts';

/**
 * Periodic work outside the outbox (delivery, retries, refetches, pruning), registered by
 * glob: any file named job.ts under packages/core/src or packages/federation/src that exports
 * `job`. The worker process runs each job at most once at a time: first when it starts, then
 * again `everyMs` after the previous run ends. A run that throws is logged and the job carries
 * on. SIGTERM aborts `signal`, and the worker waits for every run in progress to return.
 *
 * run is called outside any transaction. A job that writes does so through mutations
 * (authorized as systemPrincipal(db, <job name>)), or through a raw transaction where the
 * core-tx-access lint allows one. Every worker process runs every job, so a job must be safe
 * when two workers run it at once: claim rows with a lease or FOR UPDATE SKIP LOCKED, or hold
 * an advisory lock.
 */
export interface Job {
  /** Unique across jobs and outbox consumers; the worker refuses a clash at start. */
  readonly name: string;
  /** The pause between the end of one run and the start of the next, in milliseconds. */
  readonly everyMs: number;
  /** One run. It should return soon after `signal` aborts (the worker is stopping). */
  run(signal: AbortSignal): Promise<void>;
}

/** setTimeout's ceiling: a longer delay would fire at once. */
const maxEveryMs = 2 ** 31 - 1;

export function defineJob(spec: { name: string; everyMs: number; run(signal: AbortSignal): Promise<void> }): Job {
  const { name, everyMs } = spec;
  if (!Number.isSafeInteger(everyMs) || everyMs < 1 || everyMs > maxEveryMs) {
    throw new RangeError(`job ${name}: everyMs must be a whole number of milliseconds from 1 to ${maxEveryMs}, not ${everyMs}`);
  }
  return { name, everyMs, run: (signal) => spec.run(signal) };
}

/**
 * Throws, before the worker starts, when two jobs share a name or a job has an outbox
 * consumer's name: one name per piece of work keeps its log lines and any lock keyed by it apart.
 */
export function assertJobsRunnable(jobs: readonly Job[], consumers: readonly Consumer[] = []): void {
  const consumerNames = new Set(consumers.map(({ name }) => name));
  const seen = new Set<string>();
  for (const { name } of jobs) {
    if (seen.has(name)) throw new Error(`two jobs are named ${name}; job names must be unique`);
    if (consumerNames.has(name)) throw new Error(`job ${name} has the name of an outbox consumer; names must be unique across both`);
    seen.add(name);
  }
}

export type JobRunnerOptions = {
  signal: AbortSignal;
  jobs: readonly Job[];
  onError?: (job: Job, error: unknown) => void;
};

/**
 * Runs every job on its own schedule (see Job) until `signal` aborts, then resolves once the
 * runs in progress have returned. Throws on duplicate job names.
 */
export async function runJobs({
  signal,
  jobs,
  onError = (job, error) => console.error(`job ${job.name} failed`, error),
}: JobRunnerOptions): Promise<void> {
  assertJobsRunnable(jobs);
  await Promise.all(
    jobs.map(async (job) => {
      while (!signal.aborted) {
        try {
          await job.run(signal);
        } catch (error) {
          // A run cut short by the stop is not a failure.
          if (!(signal.aborted && isAbort(error, signal))) onError(job, error);
        }
        await pause(job.everyMs, signal);
      }
    }),
  );
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return error === signal.reason || (error instanceof Error && error.name === 'AbortError');
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
