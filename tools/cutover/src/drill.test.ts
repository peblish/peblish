import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { writer } from '@peblish/core/db/write';
import { loadFixtureSet } from '@peblish/core/fixtures/load';
import { recordDeletion, recordRestoration } from '@peblish/core/remote/ledger';
import { truncateAll } from '@peblish/core/testing/db';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  backup,
  clientMajor,
  databaseName,
  dropOwnDatabase,
  exportLedger,
  readLedgerExport,
  reapplyLedger,
  restore,
  runDrill,
  type OwnDatabase,
} from './drill.ts';

// The drill on the lane's test database: back it up, record deletions after the backup, restore
// the backup into a new database and re-apply the exported ledger. pg_dump refuses a server newer
// than itself, so this skips without client tools of the server's major version (CI's runner
// image has older ones; LANE-NOTES asks root for postgresql-client-17 there).

const [server] = await db().execute<{ major: string }>(sql`select current_setting('server_version_num')::int / 10000 as major`);
const major = Number(server?.major);
const tools = Math.min(
  (await clientMajor(process.env.PG_DUMP ?? 'pg_dump')) ?? 0,
  (await clientMajor(process.env.PG_RESTORE ?? 'pg_restore')) ?? 0,
);

describe.skipIf(tools < major)('backup and restore drill', () => {
  const url = process.env.DATABASE_URL ?? '';
  const named = (name: string) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.href;
  };
  const restoredUrl = named(`${databaseName(url)}_restored`);
  // What the drill used to restore into and drop WITH (FORCE): a database someone may be serving.
  const occupiedUrl = named(`${databaseName(url)}_drill`);
  const dir = mkdtempSync(join(tmpdir(), 'cutover-drill-'));
  const server = postgres(named('postgres'), { max: 1, onnotice: () => undefined });
  const exists = async (name: string) => (await server`select 1 from pg_database where datname = ${name}`).length > 0;
  let own: OwnDatabase | undefined;
  // Creating and dropping a database forces a checkpoint, which takes seconds while the other test projects write.
  beforeAll(async () => {
    for (const name of [databaseName(restoredUrl), databaseName(occupiedUrl)])
      await server.unsafe(`drop database if exists "${name}" with (force)`);
  }, 60_000);
  afterAll(async () => {
    if (own) await dropOwnDatabase(own);
    await server.unsafe(`drop database if exists "${databaseName(occupiedUrl)}" with (force)`);
    await server.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('a restore re-applies the deletions recorded after its backup, in ledger order', { timeout: 120_000 }, async () => {
    await truncateAll();
    const { set } = await loadFixtureSet('lab-live');
    const post = set.posts[0]!;
    const comment = set.comments.find((row) => row.postId !== post.id && row.authorId !== post.authorId)!;
    const gone = set.actors.find((row) => row.kind === 'Person' && row.id !== comment.authorId && row.id !== post.authorId)!;
    const now = new Date();

    // Before the backup: the comment's author deleted it.
    await writer().transaction(async (t) => {
      await t.update(comments).set({ deletedAt: now }).where(eq(comments.id, comment.id));
      await recordDeletion({ db: t }, { kind: 'comment', id: comment.id, cause: 'Delete', actorId: comment.authorId });
    });
    const file = join(dir, 'backup.dump');
    await backup(url, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // After it: the comment's Delete is undone, the post is deleted, an account goes with its content.
    await writer().transaction(async (t) => {
      await t.update(comments).set({ deletedAt: null }).where(eq(comments.id, comment.id));
      await recordRestoration({ db: t }, { kind: 'comment', id: comment.id, actorId: comment.authorId });
      await t.update(posts).set({ deletedAt: now }).where(eq(posts.id, post.id));
      await recordDeletion({ db: t }, { kind: 'post', id: post.id, cause: 'Gone', actorId: gone.id });
      await t.update(actors).set({ deletedAt: now, displayName: null }).where(eq(actors.id, gone.id));
      await recordDeletion({ db: t }, { kind: 'actor', id: gone.id, cause: 'Delete', actorId: gone.id, removeContent: true });
    });
    const ledger = join(dir, 'ledger.json');
    expect(await exportLedger(url, ledger)).toBe(4);

    own = await restore(file, restoredUrl);
    const restored = postgres(restoredUrl, { max: 1, onnotice: () => undefined });
    try {
      // The backup alone brings the post back and keeps the comment deleted.
      expect((await restored`select deleted_at from posts where id = ${post.id}`)[0]?.deleted_at).toBeNull();
      expect(await reapplyLedger(restoredUrl, readLedgerExport(ledger))).toEqual({ restoredRows: 1, appended: 3, applied: 4, absent: 0 });
      expect((await restored`select deleted_at from posts where id = ${post.id}`)[0]?.deleted_at).not.toBeNull();
      expect((await restored`select deleted_at from comments where id = ${comment.id}`)[0]?.deleted_at).toBeNull();
      const [actor] = await restored`select deleted_at, display_name from actors where id = ${gone.id}`;
      expect(actor).toMatchObject({ display_name: null });
      expect(actor?.deleted_at).not.toBeNull();
      const [alive] = await restored<{ n: number }[]>`
        select count(*)::int as n from posts where author_id = ${gone.id} and deleted_at is null`;
      expect(alive?.n).toBe(0);
      const ids = await restored<{ id: string }[]>`select id from deletion_ledger order by id`;
      expect(ids.map((row) => Number(row.id))).toEqual(readLedgerExport(ledger).map((row) => row.id));
      // The next ledger row continues after the re-applied ones.
      const [next] = await restored<{ id: string }[]>`
        insert into deletion_ledger (subject_kind, subject_id, reason) values ('post', ${post.id}, 'remote.object_gone') returning id`;
      expect(Number(next?.id)).toBe(Math.max(...ids.map((row) => Number(row.id))) + 1);
      // Applied again, nothing changes: every rule is idempotent.
      expect(await reapplyLedger(restoredUrl, readLedgerExport(ledger))).toMatchObject({ appended: 0, applied: 5 });
    } finally {
      await restored.end({ timeout: 5 });
    }
  });

  test('a ledger row with no rule stops the re-apply and changes nothing', { timeout: 30_000 }, async () => {
    const before = readLedgerExport(join(dir, 'ledger.json'));
    const unknown = { ...before[0]!, id: 9_999, reason: 'remote.something_new' };
    await expect(reapplyLedger(restoredUrl, [...before, unknown])).rejects.toThrow(/no rule for comment remote.something_new/);
    const restored = postgres(restoredUrl, { max: 1, onnotice: () => undefined });
    try {
      expect((await restored`select id from deletion_ledger where id = 9999`).length).toBe(0);
    } finally {
      await restored.end({ timeout: 5 });
    }
  });

  test('the drill restores into a new database of its own and drops only that one', { timeout: 120_000 }, async () => {
    await server.unsafe(`create database "${databaseName(occupiedUrl)}"`);
    const occupied = postgres(occupiedUrl, { max: 1, onnotice: () => undefined });
    try {
      await occupied`create table served (n int)`;
      await occupied`insert into served values (1)`;
      const report = await runDrill(url, join(dir, 'drill'));
      expect(report.database).toMatch(/^drill_\d{8}t\d{6}_[0-9a-f]{6}$/);
      expect(report.differences).toEqual([]);
      expect(await exists(report.database)).toBe(false);
      // The database with the old drill name is still there, and its session was not ended.
      expect((await occupied<{ n: number }[]>`select n from served`).map((row) => row.n)).toEqual([1]);
    } finally {
      await occupied.end({ timeout: 5 });
    }
  });

  test(
    'a restore refuses an existing database and a name Postgres would cut; a drop refuses a database it did not create',
    { timeout: 60_000 },
    async () => {
      const file = join(dir, 'backup.dump');
      await expect(restore(file, occupiedUrl)).rejects.toThrow(/already exists; restore only into a new database/);
      const long = `${'a'.repeat(60)}_xyz`;
      await expect(restore(file, named(long))).rejects.toThrow(/longer than 63 bytes/);
      expect(await exists(long.slice(0, 63))).toBe(false);
      await expect(
        dropOwnDatabase({ url: occupiedUrl, name: databaseName(occupiedUrl), marker: 'peblish.cutover restore other' }),
      ).rejects.toThrow(/was not created by this run/);
      expect(await exists(databaseName(occupiedUrl))).toBe(true);
    },
  );
});
