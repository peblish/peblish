import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MailMessage } from '@peblish/core/identity/mail';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { alertConfig, mailAlerter } from './alerts.ts';
import { backupBucket, bucketConfigFromEnv, UnverifiedObject, type BucketConfig } from './bucket.ts';
import { fakeS3, type FakeS3 } from './fake-s3.ts';
import {
  fetchForRestore,
  isDue,
  lastSlot,
  parseStatus,
  postgresSource,
  runOnce,
  scheduler,
  statusKey,
  statusReport,
  type Kind,
  type Lock,
  type Source,
  type Status,
} from './nightly.ts';

// The backup's failure paths without Postgres or a real bucket: a fake S3 on loopback
// (fake-s3.ts) and a fake source for the lock and the dump. The runs against MinIO and the test
// database are in nightly.test.ts.

const good = {
  BACKUP_S3_ENDPOINT: 'https://storage.example',
  BACKUP_S3_BUCKET: 'backups',
  BACKUP_S3_REGION: 'us-east-1',
  BACKUP_S3_ACCESS_KEY_ID: 'backup-key',
  BACKUP_S3_SECRET_ACCESS_KEY: 'backup-secret',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'media-key',
};

describe('the backup bucket configuration', () => {
  test('a bare https origin and a bucket of its own are accepted', () => {
    expect(bucketConfigFromEnv(good).BACKUP_S3_ENDPOINT).toBe('https://storage.example');
    expect(bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: 'https://storage.example/' }).BACKUP_S3_ENDPOINT).toBe(
      'https://storage.example',
    );
  });

  test.each([
    [
      'a path (path-style requests would land under another bucket)',
      { BACKUP_S3_ENDPOINT: 'https://storage.example/media' },
      /origin only/,
    ],
    ['a query', { BACKUP_S3_ENDPOINT: 'https://storage.example?x=1' }, /origin only/],
    ['an empty query', { BACKUP_S3_ENDPOINT: 'https://storage.example/?' }, /origin only/],
    ['a fragment', { BACKUP_S3_ENDPOINT: 'https://storage.example#a' }, /origin only/],
    ['credentials', { BACKUP_S3_ENDPOINT: 'https://user:hunter22@storage.example' }, /must not carry credentials/],
    ['plain http', { BACKUP_S3_ENDPOINT: 'http://storage.example' }, /must be https/],
    ['another scheme', { BACKUP_S3_ENDPOINT: 'ftp://storage.example' }, /must be https/],
    ['an odd opt-out value', { BACKUP_S3_ENDPOINT: 'http://storage.example', BACKUP_S3_ALLOW_PLAIN_HTTP: 'yes' }, /must be 1 or unset/],
    ['the media bucket', { BACKUP_S3_BUCKET: 'media' }, /is the media bucket/],
    ['the media key', { BACKUP_S3_ACCESS_KEY_ID: 'media-key' }, /is the media key/],
    ['a bucket name S3 refuses', { BACKUP_S3_BUCKET: 'Backups' }, /not a valid bucket name/],
    ['a media bucket name S3 refuses', { S3_BUCKET: 'media/x' }, /S3_BUCKET is not a valid bucket name/],
    ['a bucket name like an address', { BACKUP_S3_BUCKET: '10.0.0.1' }, /not a valid bucket name/],
  ])('refused: %s', (_, change, says) => {
    const attempt = () => bucketConfigFromEnv({ ...good, ...change });
    expect(attempt).toThrow(says);
    expect(attempt).not.toThrow(/hunter22/);
  });

  test('plain http only with BACKUP_S3_ALLOW_PLAIN_HTTP=1', () => {
    expect(
      bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: 'http://minio:9000', BACKUP_S3_ALLOW_PLAIN_HTTP: '1' }).BACKUP_S3_ENDPOINT,
    ).toBe('http://minio:9000');
  });

  test('S3_BUCKET is required, and a missing value is named, never quoted', () => {
    const { S3_BUCKET: _, ...withoutMedia } = good;
    expect(() => bucketConfigFromEnv(withoutMedia)).toThrow(/S3_BUCKET/);
    expect(() => bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: 'not a url hunter22' })).toThrow(/^BACKUP_S3_ENDPOINT is not a URL$/);
  });
});

describe('the schedule and the status record', () => {
  const at = (iso: string) => new Date(iso);
  const record = (change: Partial<Status> = {}): Status => ({
    object: 'backups/20261113T160000Z.dump',
    size: 10,
    sha256: 'a'.repeat(64),
    startedAt: '2026-11-13T16:00:00.000Z',
    finishedAt: '2026-11-13T16:00:01.000Z',
    ...change,
  });

  test('the dump is due once a day after 16:00 UTC, the ledger once an hour after :05, a missed run once', () => {
    expect(lastSlot('backup', at('2026-11-13T15:59:59Z')).toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(lastSlot('backup', at('2026-11-13T16:00:00Z')).toISOString()).toBe('2026-11-13T16:00:00.000Z');
    expect(lastSlot('ledger', at('2026-11-13T00:04:00Z')).toISOString()).toBe('2026-11-12T23:05:00.000Z');
    expect(isDue('backup', null, at('2026-11-13T12:00:00Z'))).toBe(true);
    expect(isDue('backup', record(), at('2026-11-14T15:59:00Z'))).toBe(false);
    expect(isDue('backup', record({ startedAt: '2026-11-10T16:00:05.000Z' }), at('2026-11-13T17:00:00Z'))).toBe(true);
  });

  const now = at('2026-11-13T17:00:00Z');
  test.each([
    ['a start time that is not a time', { startedAt: 'not-a-date' }, 'does not match its format'],
    ['a finish time that is not a time', { finishedAt: 'not-a-date' }, 'does not match its format'],
    ['a finish in the future', { finishedAt: '2026-11-14T00:00:00.000Z' }, 'is dated in the future'],
    ['a finish before the start', { finishedAt: '2026-11-13T15:00:00.000Z' }, 'finished before it started'],
    ['another kind of object', { object: 'ledger/20261113T160000Z.json' }, 'names no backup object'],
    ['a short checksum', { sha256: 'abc' }, 'does not match its format'],
    ['a negative size', { size: -1 }, 'does not match its format'],
  ])('a record with %s counts as no record, and says why', (_, change, why) => {
    expect(parseStatus('backup', JSON.stringify(record(change)), now)).toEqual({ status: null, invalid: why });
  });

  test('a good record holds, and not JSON is invalid', () => {
    expect(parseStatus('backup', JSON.stringify(record()), now).status).toEqual(record());
    expect(parseStatus('ledger', '{', now)).toEqual({ status: null, invalid: 'not JSON' });
  });
});

let s3: FakeS3;
let config: BucketConfig;
const dir = mkdtempSync(join(tmpdir(), 'backup-offline-'));
const fast = { callMs: 2_000, idleMs: 300, transferMs: () => 5_000 };
beforeAll(async () => {
  s3 = await fakeS3('backups');
  config = bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: s3.endpoint, BACKUP_S3_ALLOW_PLAIN_HTTP: '1' });
});
afterEach(() => {
  for (const key of Object.keys(s3.faults)) delete s3.faults[key as keyof typeof s3.faults];
  s3.objects.clear();
  s3.requests.length = 0;
});
afterAll(async () => {
  await s3.close();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, body: string | Buffer) => {
  const path = join(dir, name);
  rmSync(path, { force: true });
  writeFileSync(path, body, { mode: 0o600 });
  return path;
};
/** Whether the client asked to delete an object (aborting an upload's parts is not one). */
const deletedAnObject = () => s3.requests.some((r) => r.startsWith('DELETE') && !r.includes('uploadId='));

describe('uploads', () => {
  const bucket = () => backupBucket(config, { partBytes: 5 * 1024 * 1024, timeouts: fast });

  test('a failing part fails the upload, which is aborted: no object appears', async () => {
    s3.faults.failPart = 2;
    const path = file('three-parts', Buffer.alloc(11 * 1024 * 1024, 7));
    await expect(bucket().uploadFile('backups/20261113T160000Z.dump', path, 'application/octet-stream')).rejects.toThrow(
      /part 2 of 3: 500 InternalError/,
    );
    expect(s3.objects.has('backups/20261113T160000Z.dump')).toBe(false);
    expect(s3.requests.some((r) => r.startsWith('DELETE /backups/backups/20261113T160000Z.dump?uploadId='))).toBe(true);
  });

  test('bytes that differ from the file fail the check even with the right size and ETag; nothing is deleted', async () => {
    s3.faults.corrupt = true;
    const attempt = bucket().uploadFile('backups/20261113T160001Z.dump', file('nine', 'nine bytes'), 'application/octet-stream');
    await expect(attempt).rejects.toThrow(UnverifiedObject);
    await expect(attempt).rejects.toThrow(/bytes read back differ/);
    expect(deletedAnObject()).toBe(false);
  });

  test('a store with an unfamiliar ETag form is still verified, by reading the object back', async () => {
    s3.faults.etag = 'opaque-etag';
    const checked = await bucket().uploadFile('ledger/20261113T160500Z.json', file('ledger', '{"rows":[]}'), 'application/json');
    expect(checked.size).toBe(11);
    expect(s3.requests.filter((r) => r.startsWith('GET /backups/ledger/'))).toHaveLength(1);
  });

  test('a name that exists is never overwritten', async () => {
    s3.seed('backups/20261113T160002Z.dump', 'older');
    await expect(bucket().uploadFile('backups/20261113T160002Z.dump', file('x', 'newer'), 'application/octet-stream')).rejects.toThrow(
      /exists; it is never overwritten/,
    );
    expect(s3.objects.get('backups/20261113T160002Z.dump')?.body.toString()).toBe('older');
    expect(s3.requests.some((r) => r.startsWith('POST') || r.startsWith('PUT'))).toBe(false);
  });

  test('only status records are written whole', async () => {
    await expect(bucket().putSmall('backups/20261113T160003Z.dump', 'x', 'text/plain')).rejects.toThrow(/only status records/);
  });
});

describe('downloads', () => {
  const body = Buffer.alloc(64 * 1024, 3);
  const seed = async () => {
    const bucket = backupBucket(config, { timeouts: fast });
    const head = await bucket.uploadFile('backups/20261113T160000Z.dump', file('dl', body), 'application/octet-stream');
    return { bucket, expected: { size: head.size, sha256: head.sha256 } };
  };

  test('a download that stalls is abandoned after the idle timeout and its file removed', async () => {
    const { bucket, expected } = await seed();
    s3.faults.stallAfter = 1000;
    const out = join(dir, 'stalled.dump');
    const started = Date.now();
    await expect(bucket.fetchFile('backups/20261113T160000Z.dump', out, expected)).rejects.toThrow(
      /nothing received for 0 s|nothing received/,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(out)).toBe(false);
  });

  test('a slow, steady download may take longer than one call is allowed', async () => {
    const { expected } = await seed();
    s3.faults.slowChunk = 8 * 1024;
    s3.faults.slowMs = 150; // 8 chunks: about 1.2 s, against a 500 ms call limit
    const slow = backupBucket(config, { timeouts: { callMs: 500, idleMs: 400, transferMs: () => 10_000 } });
    expect(await slow.fetchFile('backups/20261113T160000Z.dump', join(dir, 'slow.dump'), expected)).toBe(body.length);
  });
});

/** A source that writes a small file; `change` swaps the lock or the dump. */
function fakeSource(change: { lock?: (kind: Kind) => Promise<Lock | null>; produce?: Source['produce'] } = {}): Source {
  const lock = async (): Promise<Lock> => ({ lost: new AbortController().signal, held: async () => true, release: async () => undefined });
  return {
    lock: change.lock ?? lock,
    produce:
      change.produce ??
      (async (kind, path) => {
        writeFileSync(path, `${kind} ${Date.now()}`, { mode: 0o600 });
        return kind === 'ledger' ? { rows: 0 } : {};
      }),
  };
}

describe('runs', () => {
  const work = mkdtempSync(join(tmpdir(), 'backup-offline-work-'));
  const saved = process.env.TMPDIR;
  beforeAll(() => {
    process.env.TMPDIR = work;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(work, { recursive: true, force: true });
  });
  const options = { timeouts: fast };

  test('a good run uploads, reads back and records itself with a valid record', async () => {
    const result = await runOnce('ledger', fakeSource(), config, options);
    expect(result.outcome, result.line).toBe('ok');
    const text = s3.objects.get(statusKey('ledger'))!.body.toString();
    expect(parseStatus('ledger', text, new Date()).invalid).toBeNull();
    expect(readdirSync(work)).toEqual([]);
  });

  test('a malformed DATABASE_URL fails the run inside its guarded path, without the password', async () => {
    const result = await runOnce('ledger', postgresSource('postgres://u:hunter2@[bad/x'), config, options);
    expect(result.outcome).toBe('failed');
    expect(result.line).not.toContain('hunter2');
    expect(result.line).toMatch(/: TypeError; its message is withheld/);
  });

  test('a run whose lock session ends mid-run fails and records nothing', async () => {
    const lost = new AbortController();
    const source = fakeSource({
      lock: async () => ({ lost: lost.signal, held: async () => !lost.signal.aborted, release: async () => undefined }),
      produce: (_kind, _path, signal) =>
        new Promise((_, reject) => {
          setTimeout(() => lost.abort(), 20);
          signal.addEventListener('abort', () => reject(new Error('killed')));
        }),
    });
    const result = await runOnce('backup', source, config, options);
    expect(result.line).toMatch(/FAILED: .* lost its database lock \(the session ended\)$/);
    expect(s3.objects.has(statusKey('backup'))).toBe(false);
    expect(readdirSync(work)).toEqual([]);
  });

  test('a run that no longer holds its lock when it would record uploads but records nothing', async () => {
    const result = await runOnce(
      'backup',
      fakeSource({ lock: async () => ({ lost: new AbortController().signal, held: async () => false, release: async () => undefined }) }),
      config,
      options,
    );
    expect(result.line).toMatch(/lost its database lock before recording; backups\/\S+ is not recorded as good$/);
    expect(s3.objects.has(statusKey('backup'))).toBe(false);
  });

  test('a dump or export that hangs is a timed-out failure, and its files go', async () => {
    const hang: Source['produce'] = (_kind, path, signal) =>
      new Promise((_, reject) => {
        writeFileSync(path, 'partial', { mode: 0o600 });
        signal.addEventListener('abort', () => reject(new Error('killed')));
      });
    const started = Date.now();
    const result = await runOnce('ledger', fakeSource({ produce: hang }), config, { ...options, produceDeadlineMs: 100 });
    expect(result.line).toMatch(/FAILED: .*: timed out$/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readdirSync(work)).toEqual([]);
  });

  test('a stop signal stops the run and removes its files', async () => {
    const stop = new AbortController();
    const result = runOnce(
      'backup',
      fakeSource({
        produce: (_k, path, signal) =>
          new Promise((_, reject) => {
            writeFileSync(path, 'x');
            setTimeout(() => stop.abort(), 20);
            signal.addEventListener('abort', () => reject(new Error('killed')));
          }),
      }),
      config,
      { ...options, signal: stop.signal },
    );
    expect((await result).line).toMatch(/: stopped$/);
    expect(readdirSync(work)).toEqual([]);
  });

  test('a run while another holds the lock is skipped', async () => {
    expect(await runOnce('ledger', fakeSource({ lock: async () => null }), config, options)).toEqual({
      outcome: 'skipped',
      line: 'ledger skipped: another ledger run holds the lock',
    });
  });
});

describe('the scheduler', () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  afterEach(() => {
    lines.length = 0;
  });

  test('with fresh records it repeats nothing; with an invalid record it says so and runs', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    const fresh = await scheduler(fakeSource({ produce: async () => Promise.reject(new Error('should not run')) }), config, {
      log,
      run: { timeouts: fast },
    });
    await fresh.tick();
    await fresh.idle();
    expect(lines.filter((l) => / (ok|FAILED)/.test(l))).toEqual([]);

    s3.seed(
      statusKey('ledger'),
      JSON.stringify({ object: 'ledger/20261113T160500Z.json', size: 1, sha256: 'a'.repeat(64), startedAt: 'not-a-date', finishedAt: 'x' }),
    );
    const s = await scheduler(fakeSource(), config, { log, run: { timeouts: fast } });
    await s.tick();
    await s.idle();
    expect(lines).toContain('ledger status record does not match its format: treated as none, so the ledger runs now');
    expect(lines.some((l) => l.startsWith('ledger ok: '))).toBe(true);
  });

  test('a source that throws a password-bearing error is a log line, never a crash or the password', async () => {
    const leaky = fakeSource({ lock: async () => Promise.reject(new Error('connect postgres://u:hunter2@db failed')) });
    const s = await scheduler(leaky, config, { log, run: { timeouts: fast } });
    await s.tick();
    await s.idle();
    expect(lines.some((l) => /^(backup|ledger) FAILED: /.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  test('stop() is bounded and stops a run in flight', async () => {
    const s = await scheduler(
      fakeSource({
        produce: (_k, _p, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
      }),
      config,
      { log, run: { timeouts: fast } },
    );
    await s.tick();
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines.some((l) => l.endsWith(': stopped'))).toBe(true);
  });
});

describe('alerts', () => {
  const sent: MailMessage[] = [];
  const lines: string[] = [];
  const alerter = () =>
    mailAlerter(
      'ops@example.test',
      backupBucket(config, { timeouts: fast }),
      'backups',
      (l) => lines.push(l),
      async (m) => void sent.push(m),
    );
  afterEach(() => {
    sent.length = 0;
    lines.length = 0;
  });

  test('mail is off, said once, without SMTP_URL, MAIL_FROM or BACKUP_ALERT_TO', () => {
    expect(alertConfig({ SMTP_URL: 'smtp://x:1025' })).toEqual({ off: 'alert mail is off: MAIL_FROM, BACKUP_ALERT_TO not set' });
    expect(alertConfig({ SMTP_URL: 'smtp://x', MAIL_FROM: 'a <a@b.c>', BACKUP_ALERT_TO: 'a@b.c, d@e.f' })).toEqual({
      off: 'alert mail is off: BACKUP_ALERT_TO is not one email address',
    });
    expect(alertConfig({ SMTP_URL: 'smtp://x', MAIL_FROM: 'a <a@b.c>', BACKUP_ALERT_TO: 'ops@example.test' })).toEqual({
      to: 'ops@example.test',
    });
  });

  test('one mail when a kind starts failing, none for its retries, one on recovery, and a restart remembers', async () => {
    const a = alerter();
    const since = new Date('2026-11-13T16:00:00Z');
    await a.problem('backup', 'failing', since, 'backups/20261112T160000Z.dump');
    await a.problem('backup', 'failing', since, 'backups/20261112T160000Z.dump');
    await a.problem('backup', 'stale', since, null);
    expect(sent.map((m) => m.subject)).toEqual(['peblish backups: the nightly database backup is failing']);
    expect(sent[0]!.text).toContain('since 2026-11-13T16:00:00.000Z');
    expect(sent[0]!.text).toContain('backup-status');

    // A new process (a restart) reads the state from the bucket: no second failure mail, and the recovery still comes.
    const b = alerter();
    await b.problem('backup', 'failing', since, null);
    await b.recovered('backup', 'backups/20261113T161500Z.dump', new Date('2026-11-13T16:15:00Z'));
    await b.recovered('backup', 'backups/20261114T160000Z.dump', new Date('2026-11-14T16:00:00Z'));
    expect(sent.map((m) => m.subject)).toEqual([
      'peblish backups: the nightly database backup is failing',
      'peblish backups: the nightly database backup works again',
    ]);
    expect(sent[1]!.text).toContain('It had been failing since 2026-11-13T16:00:00.000Z');
  });

  test('a recovery without a mailed problem sends nothing; a mail that fails is logged and tried again', async () => {
    await alerter().recovered('ledger', 'ledger/20261113T160500Z.json', new Date());
    expect(sent).toEqual([]);
    const flaky = mailAlerter(
      'ops@example.test',
      backupBucket(config, { timeouts: fast }),
      'backups',
      (l) => lines.push(l),
      async () => {
        throw new Error('smtp://user:hunter2@mail refused');
      },
    );
    await flaky.problem('ledger', 'failing', new Date(), null);
    expect(lines).toEqual(['ledger alert mail not sent: Error; its message is withheld (it can quote values)']);
    await alerter().problem('ledger', 'failing', new Date(), null);
    expect(sent).toHaveLength(1);
  });
});

describe('backup-status and the fetch for a restore', () => {
  const record = (kind: Kind, object: string, change: Partial<Status> = {}) =>
    s3.seed(
      statusKey(kind),
      JSON.stringify({
        object,
        size: 0,
        sha256: 'a'.repeat(64),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        ...change,
      }),
    );

  test('fresh records of objects that are there are good; a missing object, a mismatch or an invalid record are not', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    const good = await statusReport(config);
    expect([good.backup.problem, good.backup.stale, good.ledger.problem, good.ledger.stale]).toEqual([null, false, null, false]);

    record('backup', 'backups/20000101T000000Z.dump');
    expect((await statusReport(config)).backup).toMatchObject({
      stale: false,
      problem: 'the recorded object backups/20000101T000000Z.dump is not in the bucket',
    });
    const ledger = JSON.parse(s3.objects.get(statusKey('ledger'))!.body.toString()) as Status;
    record('ledger', ledger.object, { size: ledger.size + 1 });
    expect((await statusReport(config)).ledger.problem).toMatch(/does not match its record$/);
    record('ledger', ledger.object, { finishedAt: '2999-01-01T00:00:00.000Z' });
    expect((await statusReport(config)).ledger).toMatchObject({ stale: true, problem: 'status record is dated in the future' });
  });

  test('a restore takes what the records say was verified, passing over newer objects, and cleans up when it fails', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    s3.seed('backups/20991231T000000Z.dump', 'a newer upload that failed its check');
    s3.seed('ledger/20991231T000000Z.json', 'not good');
    const fetched = await fetchForRestore(config, join(dir, 'restore'));
    expect(fetched.chosenBy).toBe('status/backup.json and status/ledger.json (last good)');
    expect(fetched.backupObject).not.toBe('backups/20991231T000000Z.dump');
    expect(fetched.ledgerObject).not.toBe('ledger/20991231T000000Z.json');
    expect(readdirSync(join(dir, 'restore')).sort()).toHaveLength(2);

    // The recorded ledger object's bytes changed in the bucket: the fetch fails and leaves nothing.
    const ledgerObject = s3.objects.get(fetched.ledgerObject)!;
    ledgerObject.body = Buffer.from(ledgerObject.body.toString().toUpperCase());
    await expect(fetchForRestore(config, join(dir, 'restore-2'))).rejects.toThrow(/does not match its status record/);
    expect(existsSync(join(dir, 'restore-2'))).toBe(false);
  });
});

describe('the CLI', () => {
  const cli = (args: string[], env: Record<string, string>, killAfterMs?: number) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], {
        env: {
          ...process.env,
          ...env,
          BACKUP_S3_ENDPOINT: s3.endpoint,
          BACKUP_S3_BUCKET: 'backups',
          BACKUP_S3_REGION: 'us-east-1',
          BACKUP_S3_ACCESS_KEY_ID: 'k',
          BACKUP_S3_SECRET_ACCESS_KEY: 's',
          S3_BUCKET: 'media',
          BACKUP_S3_ALLOW_PLAIN_HTTP: '1',
        },
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      if (killAfterMs) setTimeout(() => child.kill('SIGTERM'), killAfterMs);
      child.on('close', (code) => resolve({ code, out }));
    });

  test('backup-schedule with a malformed DATABASE_URL refuses it without printing it', { timeout: 20_000 }, async () => {
    const { code, out } = await cli(['backup-schedule'], { DATABASE_URL: 'postgres://u:hunter2@[bad/x' }, 5_000);
    expect(out).not.toContain('hunter2');
    expect(out.trim()).toBe('DATABASE_URL (or --db) is not a valid URL');
    expect(code).toBe(64);
  });

  test('backup-schedule whose database never answers logs failures, not the URL, and stops on SIGTERM', { timeout: 30_000 }, async () => {
    const { code, out } = await cli(['backup-schedule'], { DATABASE_URL: 'postgres://u:hunter2@127.0.0.1:1/x' }, 4_000);
    expect(out).not.toContain('hunter2');
    expect(out).toMatch(/alert mail is off: /);
    expect(out).toMatch(/^ledger FAILED: ledger\/\S+ after \d+\.\d s: ECONNREFUSED/m);
    expect(out).toMatch(/backup schedule received SIGTERM/);
    expect(code).toBe(0);
  });
});
