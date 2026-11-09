// What every part of the runner shares: the lab's hosts, a small JSON HTTP client, polling, and
// the scenario recorder. The runner runs in a container on the lab network, so every peer is
// reached through Caddy at https://<name>.lab.test.
import { mkdirSync, writeFileSync } from 'node:fs';

export const PEBLISH = 'https://peblish.lab.test';
export const LEMMY = 'https://lemmy.lab.test';
export const PIEFED = 'https://piefed.lab.test';
export const MBIN = 'https://mbin.lab.test';
export const ROGUE = 'https://rogue.lab.test';

/** Every peer's lab login uses this password. */
export const PASSWORD = 'lab-password-1';

/** Run results are written here; `lab/data` is the host-visible folder (git-ignored). */
export const RESULTS_DIR = process.env.INTEROP_RESULTS_DIR ?? '/results';

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = {
  body?: unknown;
  token?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  /** Send `body` as a form (OAuth token requests) instead of JSON. */
  form?: Record<string, string>;
};

export async function http<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, options: RequestOptions = {}): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, String(value));
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(target, body === undefined ? { method, headers } : { method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, text, `${method} ${target.pathname} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `probe` returns a truthy value; throws with the last error on timeout. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 45_000, intervalMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${String(lastError)})` : ''}`);
}

/** A short unique tag for names and titles of one run (MMDDHHMMSS). */
export const runId = () => new Date().toISOString().slice(5, 19).replace(/[-:T]/g, '');

// ------------------------------------------------------------------ results

/** `pending(<lane>)` is a scenario waiting for another wave 3 lane; it runs at integration. */
export type Status = 'pass' | 'fail' | 'n/a' | 'known' | `pending(${string})`;

export type Result = {
  scenario: string;
  peer: string;
  status: Status;
  seconds: number;
  note: string;
};

/** Thrown by a scenario the peer cannot perform at all (not a failure). */
export class NotApplicable extends Error {}

/** Thrown by a scenario that cannot run until another lane's work has merged. */
export class Pending extends Error {
  readonly lane: string;
  constructor(lane: string, message: string) {
    super(message);
    this.lane = lane;
  }
}

/**
 * A documented peer defect, as the exact text the failure must carry. A failure that carries it
 * is `known`; a failure that differs is a `fail` (a different problem hides behind the old
 * label); a pass says the defect is fixed and the entry should go.
 */
export type KnownDefect = { explanation: string; signature: string };

export type Recorder = ReturnType<typeof recorder>;

/** Runs named scenarios, prints one line each, and keeps the results for `finish`. */
export function recorder(only?: readonly string[]) {
  const results: Result[] = [];
  /** `ONLY=Z1` also selects its cases, `Z1/N3`. */
  const wanted = (id: string) => !only || only.some((o) => id === o || id.startsWith(`${o}/`));
  return {
    results,
    wanted,
    async scenario(id: string, peer: string, run: () => Promise<string | void>, known?: KnownDefect): Promise<boolean> {
      if (!wanted(id)) return true;
      const started = Date.now();
      const done = (status: Status, note: string) => {
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        results.push({ scenario: id, peer, status, seconds, note });
        console.log(`${status.toUpperCase().padEnd(14)} ${id.padEnd(4)} ${peer.padEnd(8)} ${seconds}s ${note}`);
      };
      try {
        const note = (await run()) ?? '';
        done('pass', known ? `${note} (defect fixed, remove the known entry: ${known.explanation})`.trim() : note);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof NotApplicable) done('n/a', message);
        else if (error instanceof Pending) done(`pending(${error.lane})`, message);
        else if (known && message.includes(known.signature)) done('known', `${known.explanation} (${message})`);
        else done('fail', message);
        return false;
      }
    },
    /** Writes the results file and returns the process exit code: 1 when anything failed. */
    finish(file: string, run: string): number {
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(`${RESULTS_DIR}/${file}`, `${JSON.stringify({ run, at: new Date().toISOString(), results }, null, 2)}\n`);
      const count = (status: string) => results.filter((r) => r.status === status).length;
      const pending = results.filter((r) => r.status.startsWith('pending')).length;
      const extra = [
        count('known') && `${count('known')} known`,
        count('n/a') && `${count('n/a')} n/a`,
        pending && `${pending} pending`,
      ].filter(Boolean);
      console.log(`\n${count('pass')} passed, ${count('fail')} failed${extra.length ? `, ${extra.join(', ')}` : ''}; results in ${file}`);
      return count('fail') > 0 ? 1 : 0;
    },
  };
}
