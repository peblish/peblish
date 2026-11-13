import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';
import postgres from 'postgres';
import { backupBucket, type Bucket, type BucketConfig, UnverifiedObject } from './bucket.ts';
import { backup, exportLedger } from './drill.ts';
import { CutoverError, describe } from './errors.ts';

// The nightly database backup and the hourly ledger export, uploaded to the backup bucket
// (deploy/backups.md). Each run takes the dump or export with drill.ts, uploads it as
// backups/<time>.dump or ledger/<time>.json (UTC, so names sort by time), checks it from the
// bucket, and only then records it as the last good one in status/<kind>.json. Temporary files
// are mode 600 in a mode 700 folder and removed whatever the outcome. A Postgres advisory lock
// per kind on the source database keeps two runs of a kind from overlapping, whether they are
// two containers during a redeploy or a console run beside the schedule. Each run logs one line.

export type Kind = 'backup' | 'ledger';
export const kinds: readonly Kind[] = ['backup', 'ledger'];

/** The record of the last good run, written after its object was checked in the bucket. */
const Status = type({
  object: 'string',
  size: 'number',
  sha256: 'string',
  startedAt: 'string',
  finishedAt: 'string',
  'rows?': 'number',
});
export type Status = typeof Status.infer;

export const statusKey = (kind: Kind) => `status/${kind}.json`;

/** `20261113T030000Z`: UTC, to the second, sortable as text. */
export const stamp = (at: Date) => `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

export const objectName = (kind: Kind, at: Date) => (kind === 'backup' ? `backups/${stamp(at)}.dump` : `ledger/${stamp(at)}.json`);

/** The schedule, in UTC: the dump at 03:00 every day, the ledger export at five past every hour. */
export const SCHEDULE = { backup: { hour: 3, minute: 0 }, ledger: { minute: 5 } } as const;

/** The most recent time the schedule says `kind` should have run, at or before `now`. */
export function lastSlot(kind: Kind, now: Date): Date {
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  if (kind === 'backup') {
    slot.setUTCHours(SCHEDULE.backup.hour, SCHEDULE.backup.minute);
    if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  } else {
    slot.setUTCMinutes(SCHEDULE.ledger.minute);
    if (slot > now) slot.setUTCHours(slot.getUTCHours() - 1);
  }
  return slot;
}

/** Due when no good run started at or after the last slot: a missed run is caught up once. */
export const isDue = (kind: Kind, last: Status | null, now: Date) => !last || new Date(last.startedAt) < lastSlot(kind, now);

/** How old the last good run may be before `backup-status` calls it stale: one interval and some slack. */
export const STALE_AFTER_MS = { backup: 26 * 3600_000, ledger: 2 * 3600_000 } as const;

export async function readStatus(bucket: Bucket, kind: Kind): Promise<Status | null> {
  const text = await bucket.getSmall(statusKey(kind));
  if (text === null) return null;
  const parsed = Status(JSON.parse(text));
  if (parsed instanceof type.errors) throw new CutoverError(`${statusKey(kind)} does not match its format`);
  return parsed;
}

export type RunResult =
  { outcome: 'ok'; status: Status; line: string } | { outcome: 'failed'; line: string } | { outcome: 'skipped'; line: string };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A lock key per kind, the same in every process; hashtext gives Postgres' own 32-bit hash. */
const lockName = (kind: Kind) => `peblish.backup.${kind}`;

/**
 * One run of `kind` against the database `url` names. Never throws: the result carries the one
 * line to log, built from describe() so no credential, URL or row content can reach it.
 */
export async function runOnce(
  kind: Kind,
  url: string,
  config: BucketConfig,
  options: { now?: () => Date; signal?: AbortSignal; partBytes?: number } = {},
): Promise<RunResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const object = objectName(kind, started);
  const bucket = backupBucket(config, options.partBytes ? { partBytes: options.partBytes } : {});
  const lock = postgres(url, { max: 1, onnotice: () => undefined, connection: { application_name: `peblish ${lockName(kind)}` } });
  let dir: string | undefined;
  let leftBehind = false;
  try {
    const [held] = await lock<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtext(${lockName(kind)})) as ok`;
    if (!held?.ok) return { outcome: 'skipped', line: `${kind} skipped: another ${kind} run holds the lock` };
    dir = mkdtempSync(join(tmpdir(), `peblish-${kind}-`));
    const file = join(dir, kind === 'backup' ? 'backup.dump' : 'ledger.json');
    let rows: number | undefined;
    if (kind === 'backup') await backup(url, file, options.signal);
    else rows = await exportLedger(url, file);
    const head = await bucket
      .uploadFile(object, file, kind === 'backup' ? 'application/octet-stream' : 'application/json', options.signal)
      .catch(async (error: unknown) => {
        // A failed check after the upload completed leaves an object: try to remove it. The status
        // record never names it either way, so it is never taken for a good one.
        if (error instanceof UnverifiedObject) leftBehind = !(await bucket.remove(object));
        throw error;
      });
    const status: Status = {
      object,
      size: head.size,
      sha256: head.sha256,
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      ...(rows !== undefined && { rows }),
    };
    await bucket.putSmall(statusKey(kind), `${JSON.stringify(status, null, 2)}\n`, 'application/json');
    const counted = rows === undefined ? '' : `, ${rows} rows`;
    return {
      outcome: 'ok',
      status,
      line: `${kind} ok: ${object}, ${head.size} bytes${counted}, ${seconds(now().getTime() - started.getTime())}`,
    };
  } catch (error) {
    const left = leftBehind ? ` (${object} could not be removed; it is not recorded as good)` : '';
    return {
      outcome: 'failed',
      line: `${kind} FAILED: ${object} after ${seconds(now().getTime() - started.getTime())}: ${describe(error)}${left}`,
    };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    // Ending the session releases the advisory lock.
    await lock.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** After a failed run (or an unreadable status record), the next try waits this long. */
export const RETRY_AFTER_MS = 15 * 60_000;
const TICK_MS = 60_000;

/**
 * The schedule, as a long-running process (`backup-schedule`): checks every minute whether each
 * kind is due and runs it, each kind on its own so a long dump does not hold the hourly export.
 * The last good run is read from the bucket at start and again before a run, so a restart or a
 * redeploy catches a missed run up instead of losing it, and a run another process finished is
 * not repeated. SIGTERM or SIGINT stops the schedule and any run in flight (its upload is
 * aborted and its files removed) and resolves once they have stopped.
 */
export async function schedule(url: string, config: BucketConfig, log: (line: string) => void = console.log): Promise<void> {
  const bucket = backupBucket(config);
  const stop = new AbortController();
  const state = Object.fromEntries(
    kinds.map((kind) => [kind, { last: null as Status | null, retryAt: 0, running: null as Promise<void> | null }]),
  ) as Record<Kind, { last: Status | null; retryAt: number; running: Promise<void> | null }>;

  const describeLast = (kind: Kind) => {
    const last = state[kind].last;
    return last ? `${last.object} at ${last.finishedAt}` : 'none';
  };
  for (const kind of kinds) {
    try {
      state[kind].last = await readStatus(bucket, kind);
    } catch (error) {
      log(`${kind} status unreadable: ${describe(error)}`);
    }
  }
  log(
    `backup schedule started (UTC): dump daily at 03:00, ledger hourly at :05; last good backup ${describeLast('backup')}, last good ledger ${describeLast('ledger')}`,
  );

  const tick = async () => {
    const now = new Date();
    for (const kind of kinds) {
      const s = state[kind];
      if (s.running || stop.signal.aborted || now.getTime() < s.retryAt || !isDue(kind, s.last, now)) continue;
      s.running = (async () => {
        try {
          // Another process may have run it since: read the record again before running.
          s.last = await readStatus(bucket, kind);
        } catch (error) {
          s.retryAt = Date.now() + RETRY_AFTER_MS;
          log(`${kind} FAILED: status record unreadable: ${describe(error)}`);
          return;
        }
        if (!isDue(kind, s.last, new Date())) return;
        const result = await runOnce(kind, url, config, { signal: stop.signal });
        log(result.line);
        if (result.outcome === 'ok') s.last = result.status;
        else if (result.outcome === 'failed') s.retryAt = Date.now() + RETRY_AFTER_MS;
      })().finally(() => {
        s.running = null;
      });
    }
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();
    const end = (signal: string) => {
      clearInterval(timer);
      stop.abort();
      const running = kinds.map((kind) => state[kind].running).filter((p) => p !== null);
      log(`backup schedule stopping (${signal})${running.length > 0 ? `, ending ${running.length} run(s) in flight` : ''}`);
      void Promise.all(running).then(() => resolve());
    };
    process.once('SIGTERM', () => end('SIGTERM'));
    process.once('SIGINT', () => end('SIGINT'));
  });
}

export type StatusReport = Record<Kind, { last: Status | null; ageMinutes: number | null; stale: boolean }>;

/** The last good run of each kind and whether it is stale (STALE_AFTER_MS), for `backup-status`. */
export async function statusReport(config: BucketConfig, now = new Date()): Promise<StatusReport> {
  const bucket = backupBucket(config);
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      const last = await readStatus(bucket, kind);
      const age = last ? now.getTime() - new Date(last.finishedAt).getTime() : null;
      return [
        kind,
        { last, ageMinutes: age === null ? null : Math.round(age / 60_000), stale: age === null || age > STALE_AFTER_MS[kind] },
      ];
    }),
  );
  return Object.fromEntries(entries) as StatusReport;
}

/**
 * For a restore: downloads a backup (the one named, or the last good one) and the newest ledger
 * export into `dir` (created mode 700; files mode 600, checked against their sha256 records).
 */
export async function fetchForRestore(
  config: BucketConfig,
  dir: string,
  named?: string,
): Promise<{ backupObject: string; backup: string; ledgerObject: string; ledger: string }> {
  const bucket = backupBucket(config);
  const backupObject = named ?? (await readStatus(bucket, 'backup'))?.object;
  if (!backupObject) throw new CutoverError('no backup is recorded as good in status/backup.json; name one with --object');
  if (!/^backups\/[0-9TZ]+\.dump$/.test(backupObject))
    throw new CutoverError(`${backupObject} is not a backup object name (backups/<time>.dump)`);
  const ledgerObject = (await bucket.list('ledger/')).filter((o) => /^ledger\/[0-9TZ]+\.json$/.test(o.key)).at(-1)?.key;
  if (!ledgerObject) throw new CutoverError('the bucket holds no ledger export');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) throw new CutoverError(`${dir} is readable by others; use a mode 700 folder`);
  const backupFile = join(dir, backupObject.slice('backups/'.length));
  const ledgerFile = join(dir, `ledger-${ledgerObject.slice('ledger/'.length)}`);
  await bucket.fetchFile(backupObject, backupFile);
  await bucket.fetchFile(ledgerObject, ledgerFile);
  return { backupObject, backup: backupFile, ledgerObject, ledger: ledgerFile };
}
