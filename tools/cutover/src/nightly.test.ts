import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { clientMajor, exportLedger, readLedgerExport, runDrill } from './drill.ts';
import { fetchForRestore, LOCK_NAMESPACE, lockKey, postgresSource, readStatus, runOnce } from './nightly.ts';

// The nightly backup and hourly ledger export against the lane's test database and MinIO: real
// runs, a restore drill from the bucket, a lock session killed mid-run, a held table lock, and a
// one-shot run stopped by SIGTERM. Skipped without S3_ENDPOINT or Postgres client tools of the
// server's major version, as the drill's tests are. The failure paths without either are in
// backup-offline.test.ts.

const [server] = await db().execute<{ major: string }>(sql`select current_setting('server_version_num')::int / 10000 as major`);
const tools = Math.min(
  (await clientMajor(process.env.PG_DUMP ?? 'pg_dump')) ?? 0,
  (await clientMajor(process.env.PG_RESTORE ?? 'pg_restore')) ?? 0,
);

describe.skipIf(!process.env.S3_ENDPOINT || tools < Number(server?.major))('runs against MinIO and the test database', () => {
  const url = process.env.DATABASE_URL ?? '';
  const source = postgresSource(url);
  const { S3_ENDPOINT = '', S3_REGION = '', S3_ACCESS_KEY_ID = '', S3_SECRET_ACCESS_KEY = '' } = process.env;
  const bucketName = `peblish-backup-test-${randomBytes(4).toString('hex')}`;
  // The dev MinIO has one key, so the media key is left out here (production refuses a shared one).
  const env = {
    BACKUP_S3_ENDPOINT: S3_ENDPOINT,
    BACKUP_S3_BUCKET: bucketName,
    BACKUP_S3_REGION: S3_REGION,
    BACKUP_S3_ACCESS_KEY_ID: S3_ACCESS_KEY_ID,
    BACKUP_S3_SECRET_ACCESS_KEY: S3_SECRET_ACCESS_KEY,
    BACKUP_S3_ALLOW_PLAIN_HTTP: '1',
    S3_BUCKET: process.env.S3_BUCKET ?? 'media',
  };
  const config: BucketConfig = bucketConfigFromEnv(env);
  const bucket = backupBucket(config);
  const dir = mkdtempSync(join(tmpdir(), 'cutover-nightly-'));
  const work = join(dir, 'tmp');
  const savedTmp = process.env.TMPDIR;
  const fakeDump = (seconds: number) => {
    const bin = mkdtempSync(join(dir, 'fake-pg-dump-'));
    const path = join(bin, 'pg_dump');
    writeFileSync(path, `#!/bin/sh\nprintf PGDMP\nsleep ${seconds}\n`);
    chmodSync(path, 0o700);
    return { path, remove: () => rmSync(bin, { recursive: true, force: true }) };
  };

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
      expect(await bucket.fetchFile('test/big.bin', back, head)).toBe(head.size);
      expect(await fileSha256(back)).toBe(head.sha256);
      expect(statSync(back).mode & 0o777).toBe(0o600);
    },
  );

  test('the ledger export streams every row and reads back as the same rows', { timeout: 60_000 }, async () => {
    await truncateAll();
    const { set } = await loadFixtureSet('lab-live');
    for (const comment of set.comments.slice(0, 3)) {
      await writer().transaction((t) =>
        recordDeletion({ db: t }, { kind: 'comment', id: comment.id, cause: 'Delete', actorId: comment.authorId }),
      );
    }
    const file = join(dir, 'ledger-stream.json');
    expect(await exportLedger(url, file)).toBe(3);
    const rows = readLedgerExport(file);
    expect(rows.map((r) => r.subjectId)).toEqual(set.comments.slice(0, 3).map((c) => c.id));
    expect(rows[0]).toMatchObject({
      subjectKind: 'comment',
      reason: expect.any(String),
      details: expect.objectContaining({ remote: true }),
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

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

      const backup = await runOnce('backup', source, config);
      expect(backup.outcome, backup.line).toBe('ok');
      expect(backup.line).toMatch(/^backup ok: backups\/\d{8}T\d{6}\.\d{3}Z\.dump, \d+ bytes, \d+\.\d s$/);
      const ledger = await runOnce('ledger', source, config);
      expect(ledger.line).toMatch(/^ledger ok: ledger\/\d{8}T\d{6}\.\d{3}Z\.json, \d+ bytes, 1 rows, \d+\.\d s$/);
      for (const line of [backup.line, ledger.line]) {
        expect(line).not.toContain(S3_SECRET_ACCESS_KEY);
        expect(line).not.toContain('127.0.0.1');
      }
      expect(readdirSync(work)).toEqual([]);
      const recorded = (await readStatus(bucket, 'backup')).status!;
      expect((await bucket.head(recorded.object))?.size).toBe(recorded.size);
      expect((await readStatus(bucket, 'ledger')).status?.rows).toBe(1);

      // A deletion after the backup is only in a later ledger export: the restore must re-apply it.
      await deleteComment(second!);
      expect((await runOnce('ledger', source, config)).outcome).toBe('ok');

      const fetched = await fetchForRestore(config, join(dir, 'fetched'));
      expect(fetched.backupObject).toBe(recorded.object);
      expect(fetched.ledgerObject).toBe((await readStatus(bucket, 'ledger')).status!.object);
      const report = await runDrill(url, join(dir, 'drill'), { files: { backup: fetched.backup, ledger: fetched.ledger } });
      // The backup has the first deletion; the newest export adds the second, and the restore applies both.
      expect(report.reapplied).toMatchObject({ restoredRows: 1, appended: 1, applied: 2, absent: 0 });
      expect(report.differences).toEqual([]);
    },
  );

  test('a failed run exits as failed, names no secret or endpoint, records nothing and leaves no files', { timeout: 60_000 }, async () => {
    const before = await readStatus(bucket, 'backup');
    const objects = await bucket.list('backups/');
    const result = await runOnce('backup', source, { ...config, BACKUP_S3_SECRET_ACCESS_KEY: 'wrong-secret-value' });
    expect(result.outcome).toBe('failed');
    expect(result.line).toMatch(/^backup FAILED: backups\/\S+\.dump after \d+\.\d s: head backups\/\S+: 403$/);
    expect(result.line).not.toContain('wrong-secret-value');
    expect(result.line).not.toContain('127.0.0.1');
    expect(await bucket.list('backups/')).toEqual(objects);
    expect(await readStatus(bucket, 'backup')).toEqual(before);
    expect(readdirSync(work)).toEqual([]);
  });

  test('a run while another of its kind holds the lock is skipped and touches nothing', { timeout: 30_000 }, async () => {
    const other = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await other`select pg_advisory_lock(${LOCK_NAMESPACE}::int, ${lockKey('ledger')}::int)`;
      const objects = await bucket.list('ledger/');
      expect(await runOnce('ledger', source, config)).toEqual({
        outcome: 'skipped',
        line: 'ledger skipped: another ledger run holds the lock',
      });
      expect(await bucket.list('ledger/')).toEqual(objects);
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  test('a run whose lock session is killed mid-run fails and does not record itself', { timeout: 60_000 }, async () => {
    const dump = fakeDump(3);
    const saved = process.env.PG_DUMP;
    process.env.PG_DUMP = dump.path;
    const admin = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const before = await readStatus(bucket, 'backup');
      const run = runOnce('backup', postgresSource(url), config);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const [killed] = await admin<{ n: number }[]>`
        select count(pg_terminate_backend(pid))::int as n from pg_stat_activity where application_name = 'peblish backup lock backup'`;
      expect(killed?.n).toBe(1);
      const result = await run;
      expect(result.line).toMatch(/^backup FAILED: .*: lost its database lock \(the session ended\)$/);
      expect(await readStatus(bucket, 'backup')).toEqual(before);
      expect(readdirSync(work)).toEqual([]);
    } finally {
      process.env.PG_DUMP = saved;
      if (saved === undefined) delete process.env.PG_DUMP;
      await admin.end({ timeout: 5 });
      dump.remove();
    }
  });

  test('a ledger export behind a held table lock ends at its deadline as a failure', { timeout: 60_000 }, async () => {
    const holder = postgres(url, { max: 1, onnotice: () => undefined });
    const reserved = await holder.reserve();
    try {
      await reserved`begin`;
      await reserved`lock table deletion_ledger in access exclusive mode`;
      const started = Date.now();
      const result = await runOnce('ledger', source, config, { produceDeadlineMs: 2_000 });
      expect(result.line).toMatch(/^ledger FAILED: .*: timed out$/);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(readdirSync(work)).toEqual([]);
    } finally {
      await reserved`rollback`;
      reserved.release();
      await holder.end({ timeout: 5 });
    }
  });

  test('backup-run stopped by SIGTERM mid-dump exits as failed and leaves no temporary dump', { timeout: 60_000 }, async () => {
    const dump = fakeDump(20);
    const own = mkdtempSync(join(tmpdir(), 'backup-run-'));
    try {
      const child = spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'backup-run', 'backup'], {
        env: { ...process.env, ...env, S3_ACCESS_KEY_ID: '', DATABASE_URL: url, PG_DUMP: dump.path, TMPDIR: own },
      });
      let out = '';
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      for (let i = 0; i < 100 && readdirSync(own).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readdirSync(own), out).toHaveLength(1); // the run's folder, with the dump being written
      child.kill('SIGTERM');
      expect(await closed).toBe(1);
      expect(out).toMatch(/^backup FAILED: .*: stopped$/m);
      expect(readdirSync(own)).toEqual([]);
    } finally {
      dump.remove();
      rmSync(own, { recursive: true, force: true });
    }
  });
});
