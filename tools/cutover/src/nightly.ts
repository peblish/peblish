import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';
import postgres from 'postgres';
import type { Alerter } from './alerts.ts';
import { backupBucket, type Bucket, type BucketConfig, type Timeouts } from './bucket.ts';
import { backup, exportLedger } from './drill.ts';
import { CutoverError, describe } from './errors.ts';

// The nightly database backup and the hourly ledger export, uploaded to the backup bucket
// (deploy/backups.md). Each run takes the dump or export with drill.ts, uploads it as
// backups/<time>.dump or ledger/<time>.json (UTC, so names sort by time), reads it back from the
// bucket, and only then records it as the last good one in status/<kind>.json. Temporary files
// are mode 600 in a mode 700 folder and removed whatever the outcome. A Postgres advisory lock
// per kind, held on a reserved session for the whole run, keeps two runs of a kind from
// overlapping; a run that loses it records nothing. Every phase has a deadline. Each run logs
// one line, built so no credential, URL or row content can reach it.

export type Kind = 'backup' | 'ledger';
export const kinds: readonly Kind[] = ['backup', 'ledger'];

const objectPattern = { backup: /^backups\/\d{8}T\d{6}(\.\d{3})?Z\.dump$/, ledger: /^ledger\/\d{8}T\d{6}(\.\d{3})?Z\.json$/ } as const;

/** The record of the last good run, written after its object was read back from the bucket. */
const StatusShape = type({
  object: 'string',
  size: 'number.integer >= 0',
  sha256: /^[0-9a-f]{64}$/,
  'etag?': 'string | null',
  startedAt: 'string.date.iso',
  finishedAt: 'string.date.iso',
  'rows?': 'number.integer >= 0',
});
export type Status = typeof StatusShape.infer;

/** A clock may be a little ahead of the one that wrote a record; more than this is not plausible. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** A status record as read: none, a good one, or one that does not hold up (and why, in fixed words). */
export type StatusRead = { status: Status | null; invalid: string | null };

/** Checks a status record strictly: its shape, its object's name for `kind`, and that its times are in order and not in the future. */
export function parseStatus(kind: Kind, text: string, now: Date): StatusRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: null, invalid: 'not JSON' };
  }
  const checked = StatusShape(value);
  if (checked instanceof type.errors) return { status: null, invalid: 'does not match its format' };
  if (!objectPattern[kind].test(checked.object)) return { status: null, invalid: `names no ${kind} object` };
  const started = Date.parse(checked.startedAt);
  const finished = Date.parse(checked.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return { status: null, invalid: 'has a time that is not a time' };
  if (started > finished) return { status: null, invalid: 'finished before it started' };
  if (finished > now.getTime() + CLOCK_SKEW_MS) return { status: null, invalid: 'is dated in the future' };
  return { status: checked, invalid: null };
}

export const statusKey = (kind: Kind) => `status/${kind}.json`;

/** `20261113T160000.123Z`: UTC to the millisecond (ISO 8601 basic form), sortable as text; two runs never share a name. */
export const stamp = (at: Date) => `${at.toISOString().slice(0, 23).replace(/[-:]/g, '')}Z`;

export const objectName = (kind: Kind, at: Date) => (kind === 'backup' ? `backups/${stamp(at)}.dump` : `ledger/${stamp(at)}.json`);

/** The schedule, in UTC: the dump at 16:00 every day (about 03:00 in Sydney), the ledger export at five past every hour. */
export const SCHEDULE = { backup: { hour: 16, minute: 0 }, ledger: { minute: 5 } } as const;

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

/** How old the last good run may be before it is stale: one interval and some slack. */
export const STALE_AFTER_MS = { backup: 26 * 3600_000, ledger: 2 * 3600_000 } as const;
const isStale = (kind: Kind, last: Status | null, now: Date) => !last || now.getTime() - Date.parse(last.finishedAt) > STALE_AFTER_MS[kind];

export async function readStatus(bucket: Bucket, kind: Kind, now = new Date(), signal?: AbortSignal): Promise<StatusRead> {
  const text = await bucket.getSmall(statusKey(kind), signal);
  return text === null ? { status: null, invalid: null } : parseStatus(kind, text, now);
}

/** The lock a run holds for its kind. `lost` aborts if its session ends; `held()` asks the server. */
export type Lock = { lost: AbortSignal; held(): Promise<boolean>; release(): Promise<void> };

/** Where a run's data comes from: the lock and the file. The database in production; fakes in tests. */
export type Source = {
  lock(kind: Kind, signal: AbortSignal): Promise<Lock | null>;
  produce(kind: Kind, file: string, signal: AbortSignal): Promise<{ rows?: number }>;
};

/** Advisory lock keys (two int4s): a namespace for peblish's backups, then the kind. */
export const LOCK_NAMESPACE = 28770;
export const lockKey = (kind: Kind) => (kind === 'backup' ? 1 : 2);

/** A held table lock fails the dump or export after this long instead of holding the run. */
const LOCK_WAIT_MS = 60_000;

/** The database `url` names. Nothing here parses or connects until a run asks, inside its guarded path. */
export function postgresSource(url: string): Source {
  return {
    async lock(kind, signal) {
      const lost = new AbortController();
      let released = false;
      const sql = postgres(url, {
        max: 1,
        // The lock lives exactly as long as this session: no lifetime limit, no idle close.
        max_lifetime: null,
        connect_timeout: 30,
        onnotice: () => undefined,
        onclose: () => {
          if (!released) lost.abort(new CutoverError('lost its database lock (the session ended)'));
        },
        connection: { application_name: `peblish backup lock ${kind}` },
      });
      const end = () => sql.end({ timeout: 5 }).catch(() => undefined);
      // `signal` bounds only getting the lock; once held, the run's release() ends the session.
      const giveUp = () => void end();
      signal.addEventListener('abort', giveUp, { once: true });
      try {
        const reserved = await sql.reserve();
        const [row] = await reserved<{ ok: boolean }[]>`select pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${lockKey(kind)}::int) as ok`;
        signal.removeEventListener('abort', giveUp);
        if (!row?.ok) {
          released = true;
          reserved.release();
          await end();
          return null;
        }
        return {
          lost: lost.signal,
          async held() {
            if (lost.signal.aborted) return false;
            try {
              const [found] = await reserved<{ ok: boolean }[]>`
                select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted
                  and classid = ${LOCK_NAMESPACE}::int::oid and objid = ${lockKey(kind)}::int::oid and objsubid = 2) as ok`;
              return found?.ok === true;
            } catch {
              return false;
            }
          },
          async release() {
            released = true;
            reserved.release();
            await end(); // ending the session releases the lock
          },
        };
      } catch (error) {
        signal.removeEventListener('abort', giveUp);
        released = true;
        await end();
        throw error;
      }
    },
    async produce(kind, file, signal) {
      if (kind === 'backup') {
        await backup(url, file, { signal, lockWaitMs: LOCK_WAIT_MS });
        return {};
      }
      return { rows: await exportLedger(url, file, { signal, lockTimeoutMs: LOCK_WAIT_MS }) };
    },
  };
}

/** The dump or export itself must finish within this; the upload and its check have their own bounds, by size. */
export const PRODUCE_DEADLINE_MS = { backup: 3 * 3600_000, ledger: 10 * 60_000 } as const;

export type RunResult =
  { outcome: 'ok'; status: Status; line: string } | { outcome: 'failed'; line: string } | { outcome: 'skipped'; line: string };

export type RunOptions = {
  now?: () => Date;
  signal?: AbortSignal;
  partBytes?: number;
  timeouts?: Partial<Timeouts>;
  produceDeadlineMs?: number;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Why a run stopped, when a signal stopped it: in fixed words. */
function stopped(error: unknown, signals: { stop?: AbortSignal | undefined; lost?: AbortSignal; deadline: AbortSignal }): string {
  if (signals.lost?.aborted) return 'lost its database lock (the session ended)';
  if (signals.deadline.aborted) return 'timed out';
  if (signals.stop?.aborted) return 'stopped';
  return describe(error);
}

/** One run of `kind`. Never throws: everything, the source's setup included, is inside its guarded path. */
export async function runOnce(kind: Kind, source: Source, config: BucketConfig, options: RunOptions = {}): Promise<RunResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const object = objectName(kind, started);
  const failed = (why: string): RunResult => ({
    outcome: 'failed',
    line: `${kind} FAILED: ${object} after ${seconds(now().getTime() - started.getTime())}: ${why}`,
  });
  const stop = options.signal;
  const deadline = new AbortController();
  let lock: Lock | null = null;
  let dir: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const bucket = backupBucket(config, {
      ...(options.partBytes && { partBytes: options.partBytes }),
      ...(options.timeouts && { timeouts: options.timeouts }),
    });
    const setup = AbortSignal.any([AbortSignal.timeout(60_000), ...(stop ? [stop] : [])]);
    lock = await source.lock(kind, setup);
    if (!lock) return { outcome: 'skipped', line: `${kind} skipped: another ${kind} run holds the lock` };
    const run = AbortSignal.any([lock.lost, deadline.signal, ...(stop ? [stop] : [])]);
    timer = setTimeout(() => deadline.abort(new CutoverError('timed out')), options.produceDeadlineMs ?? PRODUCE_DEADLINE_MS[kind]);
    dir = mkdtempSync(join(tmpdir(), `peblish-${kind}-`));
    const file = join(dir, kind === 'backup' ? 'backup.dump' : 'ledger.json');
    const { rows } = await source.produce(kind, file, run);
    if (run.aborted) throw run.reason;
    clearTimeout(timer);
    const checked = await bucket.uploadFile(
      object,
      file,
      kind === 'backup' ? 'application/octet-stream' : 'application/json',
      AbortSignal.any([lock.lost, ...(stop ? [stop] : [])]),
    );
    // Only the holder of the lock may record a run: a run that lost it may be older than another's.
    if (!(await lock.held())) return failed(`lost its database lock before recording; ${object} is not recorded as good`);
    const status: Status = {
      object,
      size: checked.size,
      sha256: checked.sha256,
      etag: checked.etag,
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      ...(rows !== undefined && { rows }),
    };
    await bucket.putSmall(statusKey(kind), `${JSON.stringify(status, null, 2)}\n`, 'application/json', stop);
    const counted = rows === undefined ? '' : `, ${rows} rows`;
    return {
      outcome: 'ok',
      status,
      line: `${kind} ok: ${object}, ${checked.size} bytes${counted}, ${seconds(now().getTime() - started.getTime())}`,
    };
  } catch (error) {
    return failed(stopped(error, { stop, deadline: deadline.signal, ...(lock && { lost: lock.lost }) }));
  } finally {
    clearTimeout(timer);
    if (dir) rmSync(dir, { recursive: true, force: true });
    await lock?.release().catch(() => undefined);
  }
}

/** After a failed run (or an unreadable status record), the next try waits this long. */
export const RETRY_AFTER_MS = 15 * 60_000;
/** On SIGTERM, runs in flight get this long to stop and clean up before the process exits anyway. */
export const SHUTDOWN_MS = 8_000;

export type Scheduler = { tick(): Promise<void>; stop(): Promise<void>; idle(): Promise<void> };

/**
 * The schedule's state and one step of it, for `schedule()` to drive every minute (and tests to
 * drive by hand). Each kind runs on its own, so a long dump does not hold the hourly export. The
 * last good run is read from the bucket at start and again before a run, so a restart or a
 * redeploy catches a missed run up instead of losing it, and a run another process finished is
 * not repeated. Every promise it starts is caught: a failure is a log line, never a crash.
 */
export async function scheduler(
  source: Source,
  config: BucketConfig,
  options: { log: (line: string) => void; alerter?: Alerter | null; now?: () => Date; run?: RunOptions } = { log: console.log },
): Promise<Scheduler> {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const bucket = backupBucket(config, options.run?.timeouts ? { timeouts: options.run.timeouts } : {});
  const stopping = new AbortController();
  const state = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      { last: null as Status | null, retryAt: 0, running: null as Promise<void> | null, failingSince: null as Date | null },
    ]),
  ) as Record<Kind, { last: Status | null; retryAt: number; running: Promise<void> | null; failingSince: Date | null }>;
  const alert = async (f: (a: Alerter) => Promise<void>) => {
    if (options.alerter) await f(options.alerter).catch((error: unknown) => log(`alert failed: ${describe(error)}`));
  };

  const read = async (kind: Kind): Promise<Status | null> => {
    const found = await readStatus(bucket, kind, now(), stopping.signal);
    if (found.invalid) log(`${kind} status record ${found.invalid}: treated as none, so the ${kind} runs now`);
    return found.status;
  };

  for (const kind of kinds) {
    try {
      state[kind].last = await read(kind);
    } catch (error) {
      log(`${kind} status unreadable: ${describe(error)}`);
    }
  }
  const describeLast = (kind: Kind) => {
    const last = state[kind].last;
    return last ? `${last.object} at ${last.finishedAt}` : 'none';
  };
  log(
    `backup schedule started (UTC): dump daily at ${String(SCHEDULE.backup.hour).padStart(2, '0')}:${String(SCHEDULE.backup.minute).padStart(2, '0')}, ledger hourly at :${String(SCHEDULE.ledger.minute).padStart(2, '0')}; last good backup ${describeLast('backup')}, last good ledger ${describeLast('ledger')}`,
  );

  const fail = async (kind: Kind, at: Date) => {
    const s = state[kind];
    s.retryAt = Date.now() + RETRY_AFTER_MS;
    s.failingSince ??= at;
    await alert((a) => a.problem(kind, 'failing', s.failingSince!, s.last?.object ?? null));
  };

  const attempt = async (kind: Kind) => {
    const s = state[kind];
    const at = now();
    try {
      // Another process may have run it since: read the record again before running.
      s.last = await read(kind);
    } catch (error) {
      log(`${kind} FAILED: status record unreadable: ${describe(error)}`);
      return fail(kind, at);
    }
    if (!isDue(kind, s.last, now())) return;
    const result = await runOnce(kind, source, config, { ...options.run, signal: stopping.signal, now });
    log(result.line);
    if (result.outcome === 'ok') {
      s.last = result.status;
      s.failingSince = null;
      await alert((a) => a.recovered(kind, result.status.object, new Date(result.status.finishedAt)));
    } else if (result.outcome === 'failed' && !stopping.signal.aborted) await fail(kind, at);
  };

  return {
    async tick() {
      const at = now();
      for (const kind of kinds) {
        const s = state[kind];
        if (s.running || stopping.signal.aborted) continue;
        if (isStale(kind, s.last, at) && s.last) {
          await alert((a) => a.problem(kind, 'stale', new Date(Date.parse(s.last!.finishedAt) + STALE_AFTER_MS[kind]), s.last!.object));
        }
        if (Date.now() < s.retryAt || !isDue(kind, s.last, at)) continue;
        s.running = attempt(kind)
          .catch((error: unknown) => log(`${kind} FAILED: ${describe(error)}`))
          .finally(() => {
            s.running = null;
          });
      }
    },
    async idle() {
      await Promise.all(kinds.map((kind) => state[kind].running));
    },
    async stop() {
      stopping.abort();
      const running = kinds.map((kind) => state[kind].running).filter((p) => p !== null);
      log(`backup schedule stopping${running.length > 0 ? `, ending ${running.length} run(s) in flight` : ''}`);
      const bounded = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_MS).unref());
      await Promise.race([Promise.all(running), bounded]);
    },
  };
}

const TICK_MS = 60_000;

/** The schedule as a long-running process (`backup-schedule`): a tick a minute until SIGTERM or SIGINT. */
export async function schedule(
  source: Source,
  config: BucketConfig,
  options: { log: (line: string) => void; alerter?: Alerter | null },
): Promise<void> {
  const s = await scheduler(source, config, options);
  const tick = () => void s.tick().catch((error: unknown) => options.log(`tick failed: ${describe(error)}`));
  await new Promise<void>((resolve) => {
    const timer = setInterval(tick, TICK_MS);
    tick();
    const end = (signal: string) => {
      clearInterval(timer);
      options.log(`backup schedule received ${signal}`);
      void s.stop().then(resolve, resolve);
    };
    process.once('SIGTERM', () => end('SIGTERM'));
    process.once('SIGINT', () => end('SIGINT'));
  });
}

export type KindReport = { last: Status | null; ageMinutes: number | null; stale: boolean; problem: string | null };
export type StatusReport = Record<Kind, KindReport>;

/**
 * The last good run of each kind, checked against the bucket: the record must hold up, and the
 * object it names must exist with its size, sha256 record and (where recorded) ETag. Anything
 * else is a problem, and `backup-status` exits non-zero for it or for a stale run.
 */
export async function statusReport(config: BucketConfig, now = new Date()): Promise<StatusReport> {
  const bucket = backupBucket(config);
  const entries = await Promise.all(
    kinds.map(async (kind): Promise<[Kind, KindReport]> => {
      const { status: last, invalid } = await readStatus(bucket, kind, now);
      if (invalid) return [kind, { last: null, ageMinutes: null, stale: true, problem: `status record ${invalid}` }];
      if (!last) return [kind, { last: null, ageMinutes: null, stale: true, problem: 'no good run recorded' }];
      const age = now.getTime() - Date.parse(last.finishedAt);
      const head = await bucket.head(last.object);
      const problem = !head
        ? `the recorded object ${last.object} is not in the bucket`
        : head.size !== last.size || head.sha256 !== last.sha256 || (last.etag && head.etag !== last.etag)
          ? `the recorded object ${last.object} does not match its record`
          : null;
      return [kind, { last, ageMinutes: Math.round(age / 60_000), stale: age > STALE_AFTER_MS[kind], problem }];
    }),
  );
  return Object.fromEntries(entries) as StatusReport;
}

/**
 * For a restore: downloads the backup and the ledger export the status records name as last good
 * (or the backup named, which must still match its own sha256 record) into `dir` (created mode
 * 700; files mode 600, each checked). Newer objects the records do not name, such as an upload
 * that failed its check, are passed over. On any failure or stop it removes what it fetched.
 */
export async function fetchForRestore(
  config: BucketConfig,
  dir: string,
  options: { object?: string; signal?: AbortSignal } = {},
): Promise<{ chosenBy: string; backupObject: string; backup: string; ledgerObject: string; ledger: string }> {
  const bucket = backupBucket(config);
  const now = new Date();
  const records = Object.fromEntries(
    await Promise.all(kinds.map(async (kind) => [kind, await readStatus(bucket, kind, now, options.signal)] as const)),
  ) as Record<Kind, StatusRead>;
  for (const kind of kinds) {
    if (records[kind].invalid)
      throw new CutoverError(`${statusKey(kind)} ${records[kind].invalid}; name the backup with --object and check the bucket by hand`);
  }
  const ledgerStatus = records.ledger.status;
  if (!ledgerStatus) throw new CutoverError('no ledger export is recorded as good in status/ledger.json');
  let backupObject = records.backup.status?.object;
  let expected = records.backup.status ? { size: records.backup.status.size, sha256: records.backup.status.sha256 } : null;
  if (options.object) {
    if (!objectPattern.backup.test(options.object))
      throw new CutoverError(`${options.object} is not a backup object name (backups/<time>.dump)`);
    const head = await bucket.head(options.object, options.signal);
    if (!head?.sha256) throw new CutoverError(`${options.object} is not in the bucket or has no sha256 record`);
    backupObject = options.object;
    expected = { size: head.size, sha256: head.sha256 };
  }
  if (!backupObject || !expected) throw new CutoverError('no backup is recorded as good in status/backup.json; name one with --object');
  const created = !exists(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) throw new CutoverError(`${dir} is readable by others; use a mode 700 folder`);
  const backupFile = join(dir, backupObject.slice('backups/'.length));
  const ledgerFile = join(dir, `ledger-${ledgerStatus.object.slice('ledger/'.length)}`);
  try {
    await bucket.fetchFile(backupObject, backupFile, expected, options.signal);
    await bucket.fetchFile(ledgerStatus.object, ledgerFile, ledgerStatus, options.signal);
  } catch (error) {
    rmSync(backupFile, { force: true });
    rmSync(ledgerFile, { force: true });
    if (created) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    chosenBy: options.object ? 'named, checked against its own sha256 record' : 'status/backup.json and status/ledger.json (last good)',
    backupObject,
    backup: backupFile,
    ledgerObject: ledgerStatus.object,
    ledger: ledgerFile,
  };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
