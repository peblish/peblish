import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { type } from 'arktype';
import postgres from 'postgres';
import type { Alerter } from './alerts.ts';
import { backupBucket, type Bucket, type BucketConfig, type Timeouts } from './bucket.ts';
import { backup, exportLedger } from './drill.ts';
import { withDeadline } from './deadline.ts';
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

/** A status record as read: none, a good one, or one that does not hold up (and why, in fixed words), with the stored record's ETag. */
export type StatusRead = { status: Status | null; invalid: string | null; etag: string | null; exists: boolean };

/** A time as this tool writes it: `toISOString()` of a real instant (30 February does not come back as itself). */
const isExactTime = (text: string) => {
  const at = Date.parse(text);
  return Number.isFinite(at) && new Date(at).toISOString() === text;
};

/** Checks a status record strictly: its shape, its object's name for `kind`, and that its times are real, in order and not in the future. */
export function parseStatus(kind: Kind, text: string, now: Date): Omit<StatusRead, 'etag' | 'exists'> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: null, invalid: 'not JSON' };
  }
  const checked = StatusShape(value);
  if (checked instanceof type.errors) return { status: null, invalid: 'does not match its format' };
  if (!objectPattern[kind].test(checked.object)) return { status: null, invalid: `names no ${kind} object` };
  if (!isExactTime(checked.startedAt) || !isExactTime(checked.finishedAt))
    return { status: null, invalid: 'has a time that is not a time' };
  if (Date.parse(checked.startedAt) > Date.parse(checked.finishedAt)) return { status: null, invalid: 'finished before it started' };
  if (Date.parse(checked.finishedAt) > now.getTime() + CLOCK_SKEW_MS) return { status: null, invalid: 'is dated in the future' };
  return { status: checked, invalid: null };
}

export const statusKey = (kind: Kind) => `status/${kind}.json`;

/** `20261113T160000.123Z`: UTC to the millisecond (ISO 8601 basic form), sortable as text. Two runs of a kind cannot share one while each holds the lock, and a name that exists is refused. */
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

export async function readStatus(bucket: Bucket, kind: Kind, now = new Date(), signal?: AbortSignal): Promise<StatusRead> {
  const found = await bucket.getSmall(statusKey(kind), signal);
  return found === null
    ? { status: null, invalid: null, etag: null, exists: false }
    : { ...parseStatus(kind, found.text, now), etag: found.etag, exists: true };
}

/** The lock a run holds for its kind. `lost` aborts if its session ends; `held()` asks the server. */
export type Lock = { lost: AbortSignal; held(): Promise<boolean>; release(): Promise<void> };

/** Where a run's data comes from: the lock and the file. The database in production; fakes in tests. */
export type Source = {
  /**
   * Names what the lock covers (one database), for the run's temporary folders: a run removes
   * leftovers of its own kind and scope only, so two services backing up different databases
   * through one temporary root never touch each other's folders.
   */
  scope(): string;
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
    // A digest of host, port and database name: no user, password or address on disk or in a log.
    scope() {
      const parsed = new URL(url);
      const host = parsed.searchParams.get('host') ?? decodeURIComponent(parsed.hostname);
      const port = parsed.port || parsed.searchParams.get('port') || '5432';
      // Without a database name Postgres uses the user's name, so that names the database then.
      const database = decodeURIComponent(parsed.pathname.slice(1)) || decodeURIComponent(parsed.username);
      return createHash('sha256').update(`${host}\n${port}\n${database}`).digest('hex').slice(0, 12);
    },
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
/** Getting the lock, asking whether it is still held, and letting it go: each bounded. */
export const LOCK_MS = { get: 60_000, check: 30_000, release: 10_000 } as const;

export type RunResult =
  | { outcome: 'ok'; status: Status; line: string }
  | { outcome: 'failed'; line: string }
  | { outcome: 'skipped'; line: string }
  /** Another run recorded a newer good run first: this one's object stays, unrecorded. Neither a failure nor a success. */
  | { outcome: 'superseded'; line: string };

export type RunOptions = {
  now?: () => Date;
  signal?: AbortSignal;
  partBytes?: number;
  timeouts?: Partial<Timeouts>;
  produceDeadlineMs?: number;
  lockMs?: Partial<Record<keyof typeof LOCK_MS, number>>;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Why a run stopped, when a signal stopped it: in fixed words. */
function stopped(error: unknown, signals: { stop?: AbortSignal | undefined; lost?: AbortSignal; deadline: AbortSignal }): string {
  if (signals.lost?.aborted) return 'lost its database lock (the session ended)';
  if (signals.deadline.aborted) return 'timed out';
  if (signals.stop?.aborted) return 'stopped';
  return describe(error);
}

/** The invalid reason that means a record from a clock ahead of this one: never written over (fail closed). */
const FUTURE = 'is dated in the future';

/**
 * The tool's own temporary root, `<TMPDIR>/peblish-backup`: created mode 700, and refused unless
 * it is a real folder (not a link) of this user with mode 700, since dumps are written there.
 */
const tempRoot = () => join(tmpdir(), 'peblish-backup');

function privateRoot(): string {
  const root = tempRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const found = lstatSync(root);
  const mine = process.getuid ? found.uid === process.getuid() : true;
  if (!found.isDirectory() || (found.mode & 0o777) !== 0o700 || !mine) {
    throw new CutoverError(`${root} is not a private folder (mode 700, this user); refusing to write there`);
  }
  return root;
}

/**
 * One run of `kind`. Never throws: everything, the source's setup included, is inside its guarded
 * path, and every wait in it is bounded (the lock, the dump or export, each transfer, the final
 * lock check, the record, the release), so a run always ends; the shutdown signal ends the lock
 * waits at once, so the temporary folder is removed before the process exits. Holding the lock,
 * it first removes folders earlier runs of its kind left in the temporary root (a process that
 * was killed). Publication is fenced: the record is written only by the holder of the lock, only
 * over the record it read (If-Match, or If-None-Match: * when there was none), never over a run
 * that started later and never over a record dated in the future (fail closed); a write the
 * store refuses means another run won. Those runs are "superseded".
 */
export async function runOnce(kind: Kind, source: Source, config: BucketConfig, options: RunOptions = {}): Promise<RunResult> {
  const now = options.now ?? (() => new Date());
  const lockMs = { ...LOCK_MS, ...options.lockMs };
  const started = now();
  const object = objectName(kind, started);
  const after = () => seconds(Math.max(0, now().getTime() - started.getTime()));
  const failed = (why: string): RunResult => ({ outcome: 'failed', line: `${kind} FAILED: ${object} after ${after()}: ${why}` });
  const superseded = (why: string): RunResult => ({
    outcome: 'superseded',
    line: `${kind} superseded: ${object} after ${after()}: ${why}; it is not recorded`,
  });
  const future = 'the recorded run is dated in the future; repair the record by hand (deploy/backups.md)';
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
    const setup = AbortSignal.any([AbortSignal.timeout(lockMs.get), ...(stop ? [stop] : [])]);
    const getting = source.lock(kind, setup);
    // A lock that arrives after its deadline, or after a stop, is let go at once.
    lock = await withDeadline(getting, lockMs.get, 'getting the lock', stop).catch(async (error: unknown) => {
      void getting.then((late) => late?.release()).catch(() => undefined);
      throw error;
    });
    if (!lock) return { outcome: 'skipped', line: `${kind} skipped: another ${kind} run holds the lock` };
    const held = lock;
    // First of all, holding the lock: no other run of this kind on this database is using these
    // folders, so they were left by a killed process. Before any bucket read, which may fail.
    const root = privateRoot();
    const prefix = `${kind}-${source.scope()}-`;
    for (const name of readdirSync(root)) if (name.startsWith(prefix)) rmSync(join(root, name), { recursive: true, force: true });
    const live = AbortSignal.any([held.lost, ...(stop ? [stop] : [])]);
    // A record from a clock ahead is never replaced, so there is no point in a dump or an upload.
    if ((await readStatus(bucket, kind, now(), live)).invalid === FUTURE) return superseded(future);
    const run = AbortSignal.any([held.lost, deadline.signal, ...(stop ? [stop] : [])]);
    timer = setTimeout(() => deadline.abort(new CutoverError('timed out')), options.produceDeadlineMs ?? PRODUCE_DEADLINE_MS[kind]);
    dir = mkdtempSync(join(root, prefix));
    const file = join(dir, kind === 'backup' ? 'backup.dump' : 'ledger.json');
    const { rows } = await source.produce(kind, file, run);
    if (run.aborted) throw run.reason;
    clearTimeout(timer);
    const contentType = kind === 'backup' ? 'application/octet-stream' : 'application/json';
    const checked = await bucket.uploadFile(object, file, contentType, live);
    // Only the holder of the lock may record a run; a check that does not answer counts as lost,
    // and a stop ends the wait at once.
    const stillHeld = await withDeadline(held.held(), lockMs.check, 'the lock check', stop).catch((error: unknown) => {
      if (stop?.aborted) throw error;
      return false;
    });
    if (!stillHeld || live.aborted) return failed(`lost its database lock before recording; ${object} is not recorded as good`);
    const before = await readStatus(bucket, kind, now(), live);
    if (before.invalid === FUTURE) return superseded(future);
    if (before.status && Date.parse(before.status.startedAt) >= started.getTime()) {
      return superseded('a run that started later is recorded');
    }
    // Without an ETag the record can only be "created", which the store refuses: say so rather than be superseded forever.
    if (before.exists && !before.etag) {
      return failed(`the bucket returned ${statusKey(kind)} without an ETag, so it cannot be replaced safely`);
    }
    const finished = now();
    if (finished < started) return failed('the clock went back during the run; nothing is recorded');
    const status: Status = {
      object,
      size: checked.size,
      sha256: checked.sha256,
      etag: checked.etag,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      ...(rows !== undefined && { rows }),
    };
    const written = await bucket.putSmall(statusKey(kind), `${JSON.stringify(status, null, 2)}\n`, 'application/json', {
      signal: live,
      replacing: before.etag,
    });
    if (!written) return superseded('another run changed the record first');
    const counted = rows === undefined ? '' : `, ${rows} rows`;
    return { outcome: 'ok', status, line: `${kind} ok: ${object}, ${checked.size} bytes${counted}, ${after()}` };
  } catch (error) {
    return failed(stopped(error, { stop, deadline: deadline.signal, ...(lock && { lost: lock.lost }) }));
  } finally {
    clearTimeout(timer);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (lock) await withDeadline(lock.release(), lockMs.release, 'letting the lock go').catch(() => undefined);
  }
}

/** After a failed or superseded run, the next try waits this long. */
export const RETRY_AFTER_MS = 15 * 60_000;
/** On SIGTERM, runs in flight get this long to stop and clean up; then the process exits anyway (cli.ts). */
export const SHUTDOWN_MS = 8_000;

export type Scheduler = { tick(): Promise<void>; stop(): Promise<void>; idle(): Promise<void> };

/** The part of a FAILED line after its object and time: fixed words from describe(), kept to plain characters. */
const failureWord = (line: string) =>
  /^\S+ FAILED: \S+ after [\d.]+ s: (.*)$/
    .exec(line)?.[1]
    ?.replace(/[^A-Za-z0-9 ()._;,:/-]/g, '')
    .slice(0, 120) ?? null;

/**
 * The schedule's state and one step of it, for `schedule()` to drive every minute (and tests to
 * drive by hand). Each tick reads both status records from the bucket (whoever wrote them), then
 * for each kind, whether or not a run of it is going: works out its age (from the last good
 * run's finish, or from this process's start when there is no readable record), hands an overdue
 * kind to the alerter (which mails at most once a day per kind, and never waits), and starts a
 * run when one is due. Each kind runs on its own, so a long dump does not hold the hourly export,
 * and a restart catches a missed run up instead of losing it. A tick waits only for its two
 * reads, never for a run or a mail; a tick that finds the previous one still reading does
 * nothing. Every promise it starts is caught: a failure is a log line.
 */
export async function scheduler(
  source: Source,
  config: BucketConfig,
  options: { log: (line: string) => void; alerter?: Alerter | null; now?: () => Date; run?: RunOptions } = { log: console.log },
): Promise<Scheduler> {
  const { log } = options;
  const alerter = options.alerter ?? null;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const bucket = backupBucket(config, options.run?.timeouts ? { timeouts: options.run.timeouts } : {});
  const stopping = new AbortController();
  type KindState = { last: Status | null; retryAt: number; running: Promise<void> | null; lastFailure: string | null };
  const state = Object.fromEntries(
    kinds.map((kind) => [kind, { last: null, retryAt: 0, running: null, lastFailure: null } satisfies KindState]),
  ) as Record<Kind, KindState>;

  /** Reads both records; one that cannot be read counts as none, and all such are logged in one line. */
  const refresh = async () => {
    const problems = new Map<Kind, string>();
    await Promise.all(
      kinds.map(async (kind) => {
        try {
          const found = await readStatus(bucket, kind, now(), stopping.signal);
          state[kind].last = found.status;
          if (found.invalid) problems.set(kind, found.invalid);
        } catch (error) {
          state[kind].last = null;
          problems.set(kind, `unreadable (${describe(error)})`);
        }
      }),
    );
    if (problems.size > 0) {
      log(
        `status records: ${kinds.flatMap((kind) => (problems.has(kind) ? [`${kind} ${problems.get(kind)}`] : [])).join(', ')}; counted as none`,
      );
    }
  };

  await refresh();
  try {
    if (!(await bucket.honoursConditions(stopping.signal))) {
      log('the backup bucket ignores conditional writes: status records are fenced by the lock alone (deploy/backups.md)');
    }
  } catch (error) {
    log(`conditional write check failed: ${describe(error)}`);
  }
  const describeLast = (kind: Kind) => {
    const last = state[kind].last;
    return last ? `${last.object} at ${last.finishedAt}` : 'none';
  };
  const hhmm = `${String(SCHEDULE.backup.hour).padStart(2, '0')}:${String(SCHEDULE.backup.minute).padStart(2, '0')}`;
  log(
    `backup schedule started (UTC): dump daily at ${hhmm}, ledger hourly at :${String(SCHEDULE.ledger.minute).padStart(2, '0')}; last good backup ${describeLast('backup')}, last good ledger ${describeLast('ledger')}`,
  );

  const attempt = async (kind: Kind) => {
    const s = state[kind];
    const result = await runOnce(kind, source, config, { ...options.run, signal: stopping.signal, now });
    log(result.line);
    if (result.outcome === 'ok') {
      s.last = result.status;
      s.lastFailure = null;
    } else if (result.outcome === 'failed' || result.outcome === 'superseded') {
      if (result.outcome === 'failed') s.lastFailure = failureWord(result.line);
      if (!stopping.signal.aborted) s.retryAt = now().getTime() + RETRY_AFTER_MS;
    }
  };

  let reading = false;
  return {
    async tick() {
      if (reading || stopping.signal.aborted) return;
      reading = true;
      try {
        await refresh();
      } finally {
        reading = false;
      }
      const at = now().getTime();
      for (const kind of kinds) {
        const s = state[kind];
        const ageMs = at - (s.last ? Date.parse(s.last.finishedAt) : startedAt);
        if (ageMs > STALE_AFTER_MS[kind])
          alerter?.overdue({ kind, lastGood: s.last?.finishedAt ?? null, ageMs, lastFailure: s.lastFailure });
        if (s.running || stopping.signal.aborted || at < s.retryAt || !isDue(kind, s.last, new Date(at))) continue;
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
      // A mail in flight is not waited for: the process exits after this, and the mail with it.
      const bounded = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_MS).unref());
      await Promise.race([Promise.all(running), bounded]);
    },
  };
}

const TICK_MS = 60_000;

/**
 * The schedule as a long-running process (`backup-schedule`): a tick a minute until SIGTERM or
 * SIGINT. It resolves once runs in flight have stopped or SHUTDOWN_MS has passed; the CLI then
 * exits the process, which also ends any database session a stuck run still holds.
 */
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

/** The object to fetch for `kind`: the one named (checked against its own sha256 metadata), or the one the status record names. */
async function chooseObject(
  bucket: Bucket,
  kind: Kind,
  named: string | undefined,
  record: StatusRead,
  signal?: AbortSignal,
): Promise<{ object: string; size: number; sha256: string }> {
  const flag = kind === 'backup' ? '--object' : '--ledger-object';
  if (named) {
    if (!objectPattern[kind].test(named)) {
      throw new CutoverError(`${named} is not a ${kind} object name (${kind === 'backup' ? 'backups/<time>.dump' : 'ledger/<time>.json'})`);
    }
    const head = await bucket.head(named, signal);
    if (!head?.sha256) throw new CutoverError(`${named} is not in the bucket or has no sha256 record`);
    return { object: named, size: head.size, sha256: head.sha256 };
  }
  if (record.invalid) throw new CutoverError(`${statusKey(kind)} ${record.invalid}; name the ${kind} with ${flag}`);
  if (!record.status) throw new CutoverError(`no ${kind} is recorded as good in ${statusKey(kind)}; name one with ${flag}`);
  return record.status;
}

/** The real path of `path`, or of its nearest existing parent with the rest appended. */
function realish(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : join(realish(parent), full.slice(parent.length));
}

/** Whether `dir` is the temporary root or inside it, by its path as given or through links. */
function insideTempRoot(dir: string): boolean {
  const pairs: [string, string][] = [
    [resolve(dir), resolve(tempRoot())],
    [realish(dir), realish(tempRoot())],
  ];
  return pairs.some(([target, root]) => target === root || target.startsWith(root + sep));
}

/**
 * For a restore: downloads a backup and a ledger export into `dir` (created mode 700; files mode
 * 600, each checked while it downloads). Each is the one named (`object`, `ledgerObject`), which
 * must match its own sha256 metadata, or else the one its status record names as last good; a
 * named object needs no valid record for its kind. Newer objects no record names (an upload that
 * failed its check) are passed over. A destination that exists is refused before anything is
 * fetched; on any failure or stop it removes only the files and folder this call created.
 */
export async function fetchForRestore(
  config: BucketConfig,
  dir: string,
  options: { object?: string; ledgerObject?: string; signal?: AbortSignal } = {},
): Promise<{ chosenBy: string; backupObject: string; backup: string; ledgerObject: string; ledger: string }> {
  // Backup runs clear their leftovers in their temporary root, so a restore there could vanish.
  if (insideTempRoot(dir)) throw new CutoverError(`${dir} is inside ${tempRoot()}, which backup runs clear; fetch into another folder`);
  const bucket = backupBucket(config);
  const now = new Date();
  const named = { backup: options.object, ledger: options.ledgerObject };
  const records = Object.fromEntries(
    await Promise.all(kinds.map(async (kind) => [kind, named[kind] ? null : await readStatus(bucket, kind, now, options.signal)] as const)),
  ) as Record<Kind, StatusRead | null>;
  const none: StatusRead = { status: null, invalid: null, etag: null, exists: false };
  const chosen = {
    backup: await chooseObject(bucket, 'backup', named.backup, records.backup ?? none, options.signal),
    ledger: await chooseObject(bucket, 'ledger', named.ledger, records.ledger ?? none, options.signal),
  };
  const files = {
    backup: join(dir, chosen.backup.object.slice('backups/'.length)),
    ledger: join(dir, `ledger-${chosen.ledger.object.slice('ledger/'.length)}`),
  };
  for (const file of Object.values(files)) {
    if (exists(file)) throw new CutoverError(`${file} exists; fetch into an empty folder`);
  }
  const createdDir = !exists(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    if ((statSync(dir).mode & 0o077) !== 0) throw new CutoverError(`${dir} is readable by others; use a mode 700 folder`);
    for (const kind of kinds) {
      // fetchFile creates the file exclusively and removes it itself when it fails part way.
      await bucket.fetchFile(chosen[kind].object, files[kind], chosen[kind], options.signal);
      created.push(files[kind]);
    }
  } catch (error) {
    for (const file of created) rmSync(file, { force: true });
    if (createdDir) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const how = (kind: Kind) =>
    named[kind] ? `${kind} named, checked against its own sha256 record` : `${kind} from ${statusKey(kind)} (last good)`;
  return {
    chosenBy: `${how('backup')}; ${how('ledger')}`,
    backupObject: chosen.backup.object,
    backup: files.backup,
    ledgerObject: chosen.ledger.object,
    ledger: files.ledger,
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
