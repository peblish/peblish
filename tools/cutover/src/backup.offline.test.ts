import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MailMessage } from '@peblish/core/identity/mail';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { alertConfig, mailAlerter, type Alerter } from './alerts.ts';
import { backupBucket, bucketConfigFromEnv, fileSha256, UnverifiedObject, type BucketConfig } from './bucket.ts';
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
  type Scheduler,
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

  test('an impossible calendar date is not a time', () => {
    const feb30 = record({ startedAt: '2026-02-30T00:00:00.000Z', finishedAt: '2026-03-02T00:00:00.000Z' });
    expect(parseStatus('backup', JSON.stringify(feb30), now)).toEqual({ status: null, invalid: 'has a time that is not a time' });
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

  test('a writer that completes the same name first is not overwritten: the completion is conditional', async () => {
    s3.faults.beforeComplete = () => s3.seed('backups/20261113T160004.000Z.dump', 'the other writer');
    await expect(
      bucket().uploadFile('backups/20261113T160004.000Z.dump', file('seven', 'mine'), 'application/octet-stream'),
    ).rejects.toThrow(/exists; it is never overwritten/);
    expect(s3.objects.get('backups/20261113T160004.000Z.dump')?.body.toString()).toBe('the other writer');
    expect(s3.requests.some((r) => r.startsWith('DELETE /backups/backups/20261113T160004.000Z.dump?uploadId='))).toBe(true);
  });

  test('hashing, uploading and reading back each have their own budget', async () => {
    s3.faults.slowPutMs = 600;
    s3.faults.slowChunk = 4;
    s3.faults.slowMs = 100; // 12 bytes: about 300 ms to read back
    const each800 = backupBucket(config, { timeouts: { callMs: 2_000, idleMs: 1_000, transferMs: () => 800 } });
    expect(
      await each800.uploadFile('backups/20261113T160005.000Z.dump', file('eight', 'twelve bytes'), 'application/octet-stream'),
    ).toMatchObject({
      size: 12,
    });
  });

  test('a 200 answer carrying an error code that is not one plain word does not reach the message', async () => {
    s3.faults.completeError = 'Bad code: see http://x';
    const attempt = bucket().uploadFile('backups/20261113T160006.000Z.dump', file('nine', 'nine'), 'application/octet-stream');
    await expect(attempt).rejects.toThrow(/^complete upload backups\/20261113T160006\.000Z\.dump: 200 Error$/);
  });

  test('hashing stops on its signal', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(fileSha256(file('hash', 'abc'), stop.signal)).rejects.toThrow();
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
  /** What runs left in the tool's own temporary root under TMPDIR. */
  const left = () => (existsSync(join(work, 'peblish-backup')) ? readdirSync(join(work, 'peblish-backup')) : []);

  test('a good run uploads, reads back and records itself with a valid record', async () => {
    const result = await runOnce('ledger', fakeSource(), config, options);
    expect(result.outcome, result.line).toBe('ok');
    const text = s3.objects.get(statusKey('ledger'))!.body.toString();
    expect(parseStatus('ledger', text, new Date()).invalid).toBeNull();
    expect(left()).toEqual([]);
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
    expect(left()).toEqual([]);
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
    expect(left()).toEqual([]);
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
    const started = Date.now();
    expect((await result).line).toMatch(/: stopped$/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(left()).toEqual([]);
  });

  test('leftover folders of earlier runs of its kind are removed while it holds the lock; other kinds and other names stay', async () => {
    const root = join(work, 'peblish-backup');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of ['backup-old1', 'backup-old2', 'ledger-old1', 'unrelated']) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, name, 'backup.dump'), 'plaintext from a killed process', { mode: 0o600 });
    }
    expect((await runOnce('backup', fakeSource(), config, options)).outcome).toBe('ok');
    expect(left().toSorted()).toEqual(['ledger-old1', 'unrelated']);
    expect((await runOnce('backup', fakeSource({ lock: async () => null }), config, options)).outcome).toBe('skipped');
    expect((await runOnce('ledger', fakeSource({ lock: async () => null }), config, options)).outcome).toBe('skipped');
    expect(left().toSorted()).toEqual(['ledger-old1', 'unrelated']); // not without the lock
    rmSync(root, { recursive: true, force: true });
  });

  test('a temporary root that is not a private folder of this user is refused', async () => {
    const root = join(work, 'peblish-backup');
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    const result = await runOnce('ledger', fakeSource(), config, options);
    expect(result.line).toMatch(/FAILED: .*peblish-backup is not a private folder \(mode 700, this user\); refusing to write there$/);
    rmSync(root, { recursive: true, force: true });
  });

  test('the final lock check stops on the shutdown signal, and the files go before the process could be forced out', async () => {
    const stop = new AbortController();
    const source = fakeSource({
      lock: async () => ({
        lost: new AbortController().signal,
        held: () => {
          setTimeout(() => stop.abort(), 20);
          return new Promise<boolean>(() => undefined); // a session that stops answering
        },
        release: async () => undefined,
      }),
    });
    const started = Date.now();
    const result = await runOnce('backup', source, config, { ...options, signal: stop.signal });
    expect(result.line).toMatch(/: stopped$/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(left()).toEqual([]);
  });

  test('a clock that goes back during the run fails it, and nothing is recorded', async () => {
    const times = [Date.parse('2026-11-13T17:05:00.000Z')];
    const now = () => new Date(times.length > 1 ? times.shift()! : times[0]! - 10 * 60_000);
    times.push(times[0]!);
    const result = await runOnce('ledger', fakeSource(), config, { ...options, now });
    expect(result.line).toMatch(/FAILED: .*the clock went back during the run; nothing is recorded$/);
    expect(s3.objects.has(statusKey('ledger'))).toBe(false);
  });

  test('a store that returns an existing record without an ETag fails the run with a clear line', async () => {
    expect((await runOnce('ledger', fakeSource(), config, options)).outcome).toBe('ok');
    s3.faults.noEtagOnGet = true;
    const result = await runOnce('ledger', fakeSource(), config, options);
    expect(result.line).toMatch(/FAILED: .*the bucket returned status\/ledger\.json without an ETag, so it cannot be replaced safely$/);
  });

  test('a run while another holds the lock is skipped', async () => {
    expect(await runOnce('ledger', fakeSource({ lock: async () => null }), config, options)).toEqual({
      outcome: 'skipped',
      line: 'ledger skipped: another ledger run holds the lock',
    });
  });
});

describe('fenced runs', () => {
  const lock = (held: () => Promise<boolean> = async () => true): Lock => ({
    lost: new AbortController().signal,
    held,
    release: async () => undefined,
  });

  test('a final lock check that never answers ends the run as failed within its bound, recording nothing', async () => {
    const started = Date.now();
    const result = await runOnce('ledger', fakeSource({ lock: async () => lock(() => new Promise(() => undefined)) }), config, {
      timeouts: fast,
      lockMs: { check: 200 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.line).toMatch(/lost its database lock before recording; ledger\/\S+ is not recorded as good$/);
    expect(s3.objects.has(statusKey('ledger'))).toBe(false);
  });

  test('getting a lock that never answers ends the run as failed within its bound', async () => {
    const started = Date.now();
    const result = await runOnce('backup', fakeSource({ lock: () => new Promise(() => undefined) }), config, {
      timeouts: fast,
      lockMs: { get: 200 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.line).toMatch(/: getting the lock timed out$/);
  });

  const newer = {
    object: 'ledger/20991231T000000.000Z.json',
    size: 1,
    sha256: 'b'.repeat(64),
    startedAt: '2099-12-31T00:00:00.000Z',
    finishedAt: '2099-12-31T00:00:01.000Z',
  };

  test('a newer run that published while this one wrote wins: the conditional write is refused, and this run is superseded', async () => {
    // Between this run reading the record and writing it, another writer publishes a newer one.
    s3.faults.beforePut = (key) => {
      if (key === statusKey('ledger')) s3.seed(statusKey('ledger'), JSON.stringify(newer));
    };
    const result = await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    expect(result.outcome).toBe('superseded');
    expect(result.line).toMatch(
      /^ledger superseded: ledger\/\S+ after \d+\.\d s: another run changed the record first; it is not recorded$/,
    );
    expect(JSON.parse(s3.objects.get(statusKey('ledger'))!.body.toString()).object).toBe(newer.object);
  });

  test('a record of a run that started later is never replaced, even by a write the store would take', async () => {
    s3.seed(
      statusKey('ledger'),
      // Started a minute from now (a clock a little ahead) and finished a second later: a valid record of a later run.
      JSON.stringify({
        ...newer,
        startedAt: new Date(Date.now() + 60_000).toISOString(),
        finishedAt: new Date(Date.now() + 61_000).toISOString(),
      }),
    );
    s3.faults.ignoreConditions = true;
    const result = await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    expect(result.line).toMatch(/superseded: .*a run that started later is recorded/);
  });

  test('the first record is written only if there is none (If-None-Match), later ones only over the one read (If-Match)', async () => {
    expect((await runOnce('backup', fakeSource(), config, { timeouts: fast })).outcome).toBe('ok');
    expect((await runOnce('backup', fakeSource(), config, { timeouts: fast })).outcome).toBe('ok');
    const puts = s3.requests.filter((r) => r === `PUT /backups/${statusKey('backup')}`);
    expect(puts).toHaveLength(2);
  });

  test('a store that ignores conditional writes is detected, If-None-Match and If-Match alike', async () => {
    const bucket = backupBucket(config, { timeouts: fast });
    expect(await bucket.honoursConditions()).toBe(true);
    s3.faults.ignoreConditions = true;
    expect(await bucket.honoursConditions()).toBe(false);
    delete s3.faults.ignoreConditions;
    s3.faults.ignoreIfMatch = true;
    expect(await bucket.honoursConditions()).toBe(false);
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
    expect(lines).toContain('status records: ledger does not match its format; counted as none');
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

describe('the overdue rule', () => {
  const lines: string[] = [];
  const sent: MailMessage[] = [];
  const HOUR = 3600_000;
  // One fake clock for the scheduler, its runs and the alerter.
  let t = Date.parse('2026-11-13T17:00:00.000Z');
  const now = () => new Date(t);
  const clock = () => t;
  const log = (line: string) => lines.push(line);
  const record = (kind: Kind, finishedAt: number, change: Partial<Status> = {}) => {
    const at = new Date(finishedAt).toISOString();
    const object = kind === 'backup' ? 'backups/20261113T160000.000Z.dump' : 'ledger/20261113T160500.000Z.json';
    s3.seed(statusKey(kind), JSON.stringify({ object, size: 1, sha256: 'a'.repeat(64), startedAt: at, finishedAt: at, ...change }));
  };
  const alerter = (send: (m: MailMessage) => Promise<void> = async (m) => void sent.push(m)) =>
    mailAlerter('ops@example.test', 'backups', log, send, clock);
  const start = (source: Source, a = alerter()) => scheduler(source, config, { log, alerter: a, now, run: { timeouts: fast } });
  const tickAt = async (s: Scheduler, at: number, a?: Alerter) => {
    t = at;
    await s.tick();
    await a?.idle();
  };
  /** A source whose lock is always taken by someone else: every run is skipped. */
  const skipped = fakeSource({ lock: async () => null });
  afterEach(() => {
    lines.length = 0;
    sent.length = 0;
    t = Date.parse('2026-11-13T17:00:00.000Z');
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

  test('with no readable record the age counts from this process start; a kind skipped every time mails once it is overdue, then once a day', async () => {
    const t0 = t;
    const a = alerter();
    const s = await start(skipped, a);
    await tickAt(s, t0 + HOUR, a);
    expect(sent).toEqual([]);
    await tickAt(s, t0 + 2 * HOUR + 60_000, a);
    expect(sent.map((m) => m.subject)).toEqual(['peblish backups: the hourly ledger export is overdue']);
    expect(sent[0]!.text).toContain('Last good run: none recorded');
    await tickAt(s, t0 + 3 * HOUR, a);
    expect(sent).toHaveLength(1);
    // The dump's 26 hours pass; the ledger's 24-hour mark has passed too. One send at a time, so one per tick.
    await tickAt(s, t0 + 26 * HOUR + 120_000, a);
    await tickAt(s, t0 + 26 * HOUR + 180_000, a);
    expect(sent.map((m) => m.subject).toSorted()).toEqual([
      'peblish backups: the hourly ledger export is overdue',
      'peblish backups: the hourly ledger export is overdue',
      'peblish backups: the nightly database backup is overdue',
    ]);
    expect(lines.filter((l) => / (ok|FAILED)/.test(l))).toEqual([]);
  });

  test('a ledger run still going past its threshold mails, while it runs', async () => {
    record('ledger', t - 60 * 60_000);
    record('backup', t - HOUR);
    const hang: Source['produce'] = (_k, path, signal) =>
      new Promise((_, reject) => {
        writeFileSync(path, 'partial', { mode: 0o600 });
        signal.addEventListener('abort', () => reject(new Error('stopped')));
      });
    const a = alerter();
    const s = await start(fakeSource({ produce: hang }), a);
    await tickAt(s, t + 6 * 60_000, a); // past :05: the ledger run starts and hangs
    expect(sent).toEqual([]);
    await tickAt(s, t + 2 * HOUR, a); // its last good is now over two hours old
    expect(sent.map((m) => m.subject)).toEqual(['peblish backups: the hourly ledger export is overdue']);
    expect(sent[0]!.text).toMatch(/Last good run: 2026-11-13T16:00:00\.000Z, 3 h \d+ min ago\./);
    await s.stop();
  });

  test('a kind superseded every time, by a record dated in the future, is not written over and mails once overdue', async () => {
    record('ledger', t + 3 * HOUR);
    const before = s3.objects.get(statusKey('ledger'))!.body.toString();
    const a = alerter();
    const s = await start(fakeSource(), a);
    await tickAt(s, t + 6 * 60_000, a);
    await s.idle();
    expect(lines.some((l) => /^ledger superseded: .*the recorded run is dated in the future; repair the record by hand/.test(l))).toBe(
      true,
    );
    expect(s3.objects.get(statusKey('ledger'))!.body.toString()).toBe(before);
    await tickAt(s, t + 2 * HOUR + 60_000, a);
    expect(sent.map((m) => m.subject)).toContain('peblish backups: the hourly ledger export is overdue');
  });

  test('a failed run mails nothing by itself; the overdue mail later carries its filtered failure word', async () => {
    record('ledger', t - 30 * 60_000);
    record('backup', t - HOUR);
    const failing = fakeSource({ lock: async () => Promise.reject(new Error('connect postgres://u:hunter2@db refused')) });
    const a = alerter();
    const s = await start(failing, a);
    await tickAt(s, t + 6 * 60_000, a);
    await s.idle();
    expect(lines.some((l) => l.startsWith('ledger FAILED: '))).toBe(true);
    expect(sent).toEqual([]);
    await tickAt(s, t + 2 * HOUR, a);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Last failure seen by this service: Error; its message is withheld (it can quote values).');
    expect(sent.map((m) => `${m.subject}\n${m.text}`).join('\n')).not.toMatch(/hunter2|postgres:\/\//);
  });

  test('a failed send is retried no sooner than 15 minutes after it ended, and only a sent mail starts the 24 hours', async () => {
    let fail = true;
    const a = alerter(async (m) => {
      if (fail) throw new Error('smtp://user:hunter2@mail refused');
      sent.push(m);
    });
    const t0 = t;
    const s = await start(skipped, a);
    await tickAt(s, t0 + 2 * HOUR + 60_000, a);
    expect(lines).toContain('ledger overdue mail not sent (tried again in 15 min): Error; its message is withheld (it can quote values)');
    fail = false;
    await tickAt(s, t0 + 2 * HOUR + 10 * 60_000, a);
    expect(sent).toEqual([]);
    await tickAt(s, t0 + 2 * HOUR + 17 * 60_000, a);
    expect(sent).toHaveLength(1);
    await tickAt(s, t0 + 5 * HOUR, a);
    expect(sent).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  test('never two sends at once, ticks never wait for one, and shutdown is not held by it', async () => {
    const calls: MailMessage[] = [];
    const a = alerter((m) => {
      calls.push(m);
      return new Promise(() => undefined); // a mail server that never answers
    });
    const t0 = t;
    const s = await start(skipped, a);
    const started = Date.now();
    for (const minutes of [27 * 60, 27 * 60 + 1, 27 * 60 + 2]) await tickAt(s, t0 + minutes * 60_000);
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(1); // both kinds are overdue; one send in flight
    const stopping = Date.now();
    await s.stop();
    expect(Date.now() - stopping).toBeLessThan(500);
  });

  test('records that cannot be read count as none and are logged in one line per tick', async () => {
    s3.seed(statusKey('backup'), '{ not json');
    s3.seed(statusKey('ledger'), '{ not json');
    const s = await start(skipped);
    lines.length = 0;
    await tickAt(s, t + 60_000);
    await tickAt(s, t + 120_000);
    const about = lines.filter((l) => l.includes('status record'));
    expect(about).toEqual([
      'status records: backup not JSON, ledger not JSON; counted as none',
      'status records: backup not JSON, ledger not JSON; counted as none',
    ]);
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
    expect(fetched.chosenBy).toBe('backup from status/backup.json (last good); ledger from status/ledger.json (last good)');
    expect(fetched.backupObject).not.toBe('backups/20991231T000000Z.dump');
    expect(fetched.ledgerObject).not.toBe('ledger/20991231T000000Z.json');
    expect(readdirSync(join(dir, 'restore')).sort()).toHaveLength(2);

    // The recorded ledger object's bytes changed in the bucket: the fetch fails and leaves nothing.
    const ledgerObject = s3.objects.get(fetched.ledgerObject)!;
    ledgerObject.body = Buffer.from(ledgerObject.body.toString().toUpperCase());
    await expect(fetchForRestore(config, join(dir, 'restore-2'))).rejects.toThrow(/does not match its status record/);
    expect(existsSync(join(dir, 'restore-2'))).toBe(false);
  });

  test('a second fetch into the same folder is refused before fetching, and the first files stay', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    const first = await fetchForRestore(config, join(dir, 'twice'));
    const before = s3.requests.length;
    await expect(fetchForRestore(config, join(dir, 'twice'))).rejects.toThrow(/exists; fetch into an empty folder$/);
    expect(s3.requests.slice(before).some((r) => r.startsWith('GET /backups/backups/') || r.startsWith('GET /backups/ledger/'))).toBe(
      false,
    );
    expect([existsSync(first.backup), existsSync(first.ledger)]).toEqual([true, true]);
  });

  test('a failure in an existing folder removes only what this fetch made', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    const folder = join(dir, 'kept');
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'mine.txt'), 'not the fetch');
    const ledger = JSON.parse(s3.objects.get(statusKey('ledger'))!.body.toString()) as Status;
    s3.objects.get(ledger.object)!.body = Buffer.from('changed');
    await expect(fetchForRestore(config, folder)).rejects.toThrow();
    expect(readdirSync(folder)).toEqual(['mine.txt']);
  });

  test('--object and --ledger-object work without a valid status record for their kind, and still check what they fetch', async () => {
    await runOnce('backup', fakeSource(), config, { timeouts: fast });
    await runOnce('ledger', fakeSource(), config, { timeouts: fast });
    const backup = (JSON.parse(s3.objects.get(statusKey('backup'))!.body.toString()) as Status).object;
    const ledger = (JSON.parse(s3.objects.get(statusKey('ledger'))!.body.toString()) as Status).object;
    s3.seed(statusKey('backup'), '{ not json');
    await expect(fetchForRestore(config, join(dir, 'no-object'))).rejects.toThrow(
      'status/backup.json not JSON; name the backup with --object',
    );
    const fetched = await fetchForRestore(config, join(dir, 'named'), { object: backup });
    expect(fetched.chosenBy).toBe('backup named, checked against its own sha256 record; ledger from status/ledger.json (last good)');
    s3.seed(statusKey('ledger'), '{ not json');
    await expect(fetchForRestore(config, join(dir, 'no-ledger'), { object: backup })).rejects.toThrow(
      /name the ledger with --ledger-object$/,
    );
    expect((await fetchForRestore(config, join(dir, 'both'), { object: backup, ledgerObject: ledger })).ledgerObject).toBe(ledger);
    await expect(fetchForRestore(config, join(dir, 'bad'), { object: 'backups/20991231T000000.000Z.dump' })).rejects.toThrow(
      /not in the bucket or has no sha256 record/,
    );
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
