import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@peblish/core/db/read';
import { comments } from '@peblish/core/db/tables/content';
import { writer } from '@peblish/core/db/write';
import { loadFixtureSet } from '@peblish/core/fixtures/load';
import { recordDeletion } from '@peblish/core/remote/ledger';
import { s3Store } from '@peblish/core/storage/s3';
import { truncateAll } from '@peblish/core/testing/db';
import { AwsClient } from 'aws4fetch';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { backupBucket, bucketConfigFromEnv, fileSha256, multipartEtag, type BucketConfig } from './bucket.ts';
import { clientMajor, runDrill } from './drill.ts';
import { fetchForRestore, isDue, lastSlot, readStatus, runOnce, type Status } from './nightly.ts';

// The nightly backup and hourly ledger export to the backup bucket (deploy/backups.md): the
// configuration's refusals and the schedule's slots on their own, then real runs against the
// lane's test database and MinIO (skipped without S3_ENDPOINT or Postgres client tools of the
// server's major version, as the drill's tests are).

const good = {
  BACKUP_S3_ENDPOINT: 'http://127.0.0.1:18490',
  BACKUP_S3_BUCKET: 'backups',
  BACKUP_S3_REGION: 'us-east-1',
  BACKUP_S3_ACCESS_KEY_ID: 'backup-key',
  BACKUP_S3_SECRET_ACCESS_KEY: 'backup-secret',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'media-key',
};

test('the backup bucket must not be the media bucket or use its key, and the endpoint carries no credentials', () => {
  expect(bucketConfigFromEnv(good).BACKUP_S3_BUCKET).toBe('backups');
  expect(() => bucketConfigFromEnv({ ...good, BACKUP_S3_BUCKET: 'media' })).toThrow(/is the media bucket/);
  expect(() => bucketConfigFromEnv({ ...good, BACKUP_S3_ACCESS_KEY_ID: 'media-key' })).toThrow(/is the media key/);
  expect(() => bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: 'http://user:hunter22@127.0.0.1:18490' })).toThrow(
    /must not carry credentials/,
  );
  const { S3_BUCKET: _, ...withoutMedia } = good;
  expect(() => bucketConfigFromEnv(withoutMedia)).toThrow(/S3_BUCKET/);
  // A missing or bad value is named by its variable, never quoted.
  const bad = () => bucketConfigFromEnv({ ...good, BACKUP_S3_ENDPOINT: 'not a url hunter22' });
  expect(bad).toThrow(/BACKUP_S3_ENDPOINT/);
  expect(bad).not.toThrow(/hunter22/);
});

test('the schedule: the dump is due once a day after 03:00 UTC, the ledger once an hour after :05, a missed run once', () => {
  const at = (iso: string) => new Date(iso);
  expect(lastSlot('backup', at('2026-11-13T02:59:59Z')).toISOString()).toBe('2026-11-12T03:00:00.000Z');
  expect(lastSlot('backup', at('2026-11-13T03:00:00Z')).toISOString()).toBe('2026-11-13T03:00:00.000Z');
  expect(lastSlot('ledger', at('2026-11-13T00:04:00Z')).toISOString()).toBe('2026-11-12T23:05:00.000Z');
  expect(lastSlot('ledger', at('2026-11-13T10:30:00Z')).toISOString()).toBe('2026-11-13T10:05:00.000Z');
  const ran = (startedAt: string): Status => ({ object: 'x', size: 1, sha256: 'x', startedAt, finishedAt: startedAt });
  expect(isDue('backup', null, at('2026-11-13T12:00:00Z'))).toBe(true);
  expect(isDue('backup', ran('2026-11-13T03:00:05Z'), at('2026-11-13T23:59:00Z'))).toBe(false);
  // Three days down: one catch-up run, then nothing until the next slot.
  expect(isDue('backup', ran('2026-11-10T03:00:05Z'), at('2026-11-13T12:00:00Z'))).toBe(true);
  expect(isDue('backup', ran('2026-11-13T12:00:01Z'), at('2026-11-13T12:01:00Z'))).toBe(false);
  expect(isDue('ledger', ran('2026-11-13T10:05:01Z'), at('2026-11-13T11:04:00Z'))).toBe(false);
  expect(isDue('ledger', ran('2026-11-13T10:05:01Z'), at('2026-11-13T11:05:00Z'))).toBe(true);
});

const [server] = await db().execute<{ major: string }>(sql`select current_setting('server_version_num')::int / 10000 as major`);
const tools = Math.min(
  (await clientMajor(process.env.PG_DUMP ?? 'pg_dump')) ?? 0,
  (await clientMajor(process.env.PG_RESTORE ?? 'pg_restore')) ?? 0,
);

describe.skipIf(!process.env.S3_ENDPOINT || tools < Number(server?.major))('runs against MinIO and the test database', () => {
  const url = process.env.DATABASE_URL ?? '';
  const { S3_ENDPOINT = '', S3_REGION = '', S3_ACCESS_KEY_ID = '', S3_SECRET_ACCESS_KEY = '' } = process.env;
  const bucketName = `peblish-backup-test-${randomBytes(4).toString('hex')}`;
  // The dev MinIO has one key, so the media key is left out here (production refuses a shared one).
  const config: BucketConfig = {
    BACKUP_S3_ENDPOINT: S3_ENDPOINT,
    BACKUP_S3_BUCKET: bucketName,
    BACKUP_S3_REGION: S3_REGION,
    BACKUP_S3_ACCESS_KEY_ID: S3_ACCESS_KEY_ID,
    BACKUP_S3_SECRET_ACCESS_KEY: S3_SECRET_ACCESS_KEY,
    S3_BUCKET: process.env.S3_BUCKET ?? 'media',
  };
  const bucket = backupBucket(config);
  const dir = mkdtempSync(join(tmpdir(), 'cutover-nightly-'));
  const work = join(dir, 'tmp');
  const savedTmp = process.env.TMPDIR;

  beforeAll(async () => {
    await s3Store({ S3_ENDPOINT, S3_BUCKET: bucketName, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY }).ensureBucket();
    // Runs make their temporary folders under os.tmpdir(): a folder of the test's, to check they go.
    mkdirSync(work, { mode: 0o700 });
    process.env.TMPDIR = work;
  });
  afterAll(async () => {
    process.env.TMPDIR = savedTmp;
    if (savedTmp === undefined) delete process.env.TMPDIR;
    const client = new AwsClient({
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      region: S3_REGION,
      service: 's3',
    });
    const base = `${S3_ENDPOINT}/${bucketName}`;
    for (const prefix of ['backups/', 'ledger/', 'status/', 'test/']) {
      for (const { key } of await bucket.list(prefix)) await (await client.fetch(`${base}/${key}`, { method: 'DELETE' })).arrayBuffer();
    }
    await (await client.fetch(base, { method: 'DELETE' })).arrayBuffer();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test(
    'a file of several parts uploads one part at a time, checks out from the bucket and fetches back intact',
    { timeout: 60_000 },
    async () => {
      const file = join(dir, 'big.bin');
      writeFileSync(file, randomBytes(11 * 1024 * 1024 + 123), { mode: 0o600 });
      const partBytes = 5 * 1024 * 1024;
      const head = await backupBucket(config, { partBytes }).uploadFile('test/big.bin', file, 'application/octet-stream');
      expect(head.size).toBe(statSync(file).size);
      expect(head.sha256).toBe(await fileSha256(file));
      // MinIO answers S3's multipart ETag, which the upload compared with its own parts' MD5s.
      const bytes = readFileSync(file);
      const md5s = [0, 1, 2].map((n) =>
        createHash('md5')
          .update(bytes.subarray(n * partBytes, (n + 1) * partBytes))
          .digest(),
      );
      expect(head.etag).toBe(multipartEtag(md5s));
      const back = join(dir, 'back.bin');
      expect(await bucket.fetchFile('test/big.bin', back)).toBe(head.size);
      expect(await fileSha256(back)).toBe(head.sha256);
      expect(statSync(back).mode & 0o777).toBe(0o600);
    },
  );

  test(
    'a nightly and an hourly run upload under UTC names, record the last good one, leave no files, and restore',
    { timeout: 180_000 },
    async () => {
      await truncateAll();
      const { set } = await loadFixtureSet('lab-live');
      const [first, second] = set.comments;
      const deleteComment = (comment: typeof first & {}) =>
        writer().transaction(async (t) => {
          await t.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));
          await recordDeletion({ db: t }, { kind: 'comment', id: comment.id, cause: 'Delete', actorId: comment.authorId });
        });
      await deleteComment(first!);

      const backup = await runOnce('backup', url, config);
      expect(backup.outcome, backup.line).toBe('ok');
      expect(backup.line).toMatch(/^backup ok: backups\/\d{8}T\d{6}Z\.dump, \d+ bytes, \d+\.\d s$/);
      const ledger = await runOnce('ledger', url, config);
      expect(ledger.line).toMatch(/^ledger ok: ledger\/\d{8}T\d{6}Z\.json, \d+ bytes, 1 rows, \d+\.\d s$/);
      for (const line of [backup.line, ledger.line]) {
        expect(line).not.toContain(S3_SECRET_ACCESS_KEY);
        expect(line).not.toContain('127.0.0.1');
      }
      expect(readdirSync(work)).toEqual([]);
      const recorded = await readStatus(bucket, 'backup');
      expect((await bucket.head(recorded!.object))?.size).toBe(recorded!.size);
      expect((await readStatus(bucket, 'ledger'))?.rows).toBe(1);

      // A deletion after the backup is only in a later ledger export: the restore must re-apply it.
      await deleteComment(second!);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // a name of its own, to the second
      expect((await runOnce('ledger', url, config)).outcome).toBe('ok');

      const fetched = await fetchForRestore(config, join(dir, 'fetched'));
      expect(fetched.backupObject).toBe(recorded!.object);
      expect(fetched.ledgerObject).toBe((await readStatus(bucket, 'ledger'))!.object);
      const report = await runDrill(url, join(dir, 'drill'), { files: { backup: fetched.backup, ledger: fetched.ledger } });
      // The backup has the first deletion; the newest export adds the second, and the restore applies both.
      expect(report.reapplied).toMatchObject({ restoredRows: 1, appended: 1, applied: 2, absent: 0 });
      expect(report.differences).toEqual([]);
      expect(readdirSync(join(dir, 'fetched')).sort()).toEqual(
        [fetched.backup, fetched.ledger].map((f) => f.slice(f.lastIndexOf('/') + 1)).sort(),
      );
    },
  );

  test('a failed run exits as failed, names no secret or endpoint, records nothing and leaves no files', { timeout: 60_000 }, async () => {
    const before = await readStatus(bucket, 'backup');
    const objects = await bucket.list('backups/');
    const result = await runOnce('backup', url, { ...config, BACKUP_S3_SECRET_ACCESS_KEY: 'wrong-secret-value' });
    expect(result.outcome).toBe('failed');
    expect(result.line).toMatch(/^backup FAILED: backups\/\d{8}T\d{6}Z\.dump after \d+\.\d s: start upload .*: 403 SignatureDoesNotMatch$/);
    expect(result.line).not.toContain('wrong-secret-value');
    expect(result.line).not.toContain('127.0.0.1');
    expect(await bucket.list('backups/')).toEqual(objects);
    expect(await readStatus(bucket, 'backup')).toEqual(before);
    expect(readdirSync(work)).toEqual([]);

    // A port nothing listens on (fetch refuses some low ports outright, so not a fixed one).
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const { port } = closed.address() as AddressInfo;
    await new Promise((done) => closed.close(done));
    const unreachable = await runOnce('ledger', url, { ...config, BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}` });
    expect(unreachable.line).toMatch(/the bucket did not answer \(ECONNREFUSED\)$/);
  });

  test('a run while another of its kind holds the lock is skipped and touches nothing', { timeout: 30_000 }, async () => {
    const other = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await other`select pg_advisory_lock(hashtext('peblish.backup.ledger'))`;
      const objects = await bucket.list('ledger/');
      const result = await runOnce('ledger', url, config);
      expect(result).toEqual({ outcome: 'skipped', line: 'ledger skipped: another ledger run holds the lock' });
      expect(await bucket.list('ledger/')).toEqual(objects);
    } finally {
      await other.end({ timeout: 5 });
    }
  });
});
