import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { actors } from '@peblish/core/db/tables/actors';
import { media } from '@peblish/core/db/tables/media';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { owePurgeAfterRestore } from '@peblish/core/edge/debt';
import type { WriteTx } from '@peblish/core/db/write';
import { mediaEvidence } from '@peblish/core/evidence/tables';
import { categoryOf, listBlockedHash } from '@peblish/core/mediascan/block';
import { blockCategories } from '@peblish/core/mediascan/list';
import { outboxEmitter } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import type { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { openPrivate, writePrivate } from './bundle.ts';
import { CutoverError, readJsonFile } from './errors.ts';

// The backup and restore drill (T&S baseline: a restore drill that re-applies the deletion
// ledger). A backup is `pg_dump -Fc`; the ledger is also exported on its own, more often than
// backups (deploy/cutover.md), because a restore loses every row written after its backup,
// ledger rows included. After `pg_restore` into a new database, `reapplyLedger` appends the
// exported rows the backup lacks (keeping their ids) and then applies every ledger row in id
// order, so nothing deleted before the incident comes back. Files are written with mode 600.
// A restore only ever creates a new database (an existing one is refused), and the drill drops
// only the database it created, recognised by the marker it wrote on it.

type Sql = postgres.Sql;

export const LedgerRow = type({
  id: 'number.integer',
  subjectKind: "'user' | 'actor' | 'post' | 'comment' | 'media'",
  subjectId: 'string',
  subjectApId: 'string | null',
  reason: 'string',
  requestedBy: 'string | null',
  details: 'Record<string, unknown>',
  createdAt: 'string',
});
export type LedgerRow = typeof LedgerRow.infer;
const LedgerExport = type({ format: "'peblish.ledger/1'", exportedAt: 'string', rows: LedgerRow.array() });

/** The client tools' major version must be the server's or newer, or pg_dump refuses. */
export async function clientMajor(binary: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(Number(/(\d+)\.\d+/.exec(out)?.[1] ?? Number.NaN) || null));
  });
}

const pgDump = () => process.env.PG_DUMP ?? 'pg_dump';
const pgRestore = () => process.env.PG_RESTORE ?? 'pg_restore';

/** `--dbname` without the password, which goes in PGPASSWORD so it stays out of the process list. */
function connection(url: string): { arg: string; env: NodeJS.ProcessEnv } {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return { arg: `--dbname=${parsed.href}`, env: password ? { ...process.env, PGPASSWORD: password } : process.env };
}

/**
 * The kind of a pg_dump or pg_restore failure, from its first error line, cut before the first
 * colon or quote: what follows can quote a row it could not load or a value. Rerun the command by
 * hand to read all of it.
 */
function errorKind(stderr: string): string {
  const line = /^pg_\w+: error: (.*)$/m.exec(stderr)?.[1];
  const kind = line?.split(/[:"']/)[0]?.trim();
  return kind ? ` (${kind}; the rest of its error output is withheld)` : ' (its error output is withheld)';
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv, stdout: 'ignore' | number = 'ignore'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', stdout, 'pipe'], env });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new CutoverError(`${binary} exited ${code}${errorKind(err)}`))));
  });
}

/** `pg_dump -Fc` of the database `url` names into `file` (mode 600, refused if it exists). */
export async function backup(url: string, file: string): Promise<void> {
  const fd = openPrivate(file);
  try {
    const { arg, env } = connection(url);
    await run(pgDump(), ['--format=custom', '--no-owner', '--no-privileges', arg], env, fd);
  } finally {
    closeSync(fd);
  }
}

/** Postgres cuts a longer identifier to its first 63 bytes without an error (NAMEDATALEN). */
const maxNameBytes = 63;

/** The database a URL names, refused unless it is lowercase letters, digits and underscores within 63 bytes. */
export function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new CutoverError(`database name ${name} must be lowercase letters, digits and underscores`);
  if (Buffer.byteLength(name) > maxNameBytes) {
    throw new CutoverError(`database name ${name} is longer than ${maxNameBytes} bytes, so Postgres would cut it to another name`);
  }
  return name;
}

/** Runs `fn` on the server's maintenance database, with the name `url` names. */
async function onServer<T>(url: string, fn: (admin: Sql, name: string) => Promise<T>): Promise<T> {
  const name = databaseName(url);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => undefined });
  try {
    return await fn(admin, name);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * A database this process created for a restore. Its marker is the database's comment, written
 * when it was created; `dropOwnDatabase` drops nothing whose comment is not this marker.
 */
export type OwnDatabase = { url: string; name: string; marker: string };

async function createOwnDatabase(url: string): Promise<OwnDatabase> {
  return onServer(url, async (admin, name) => {
    const exists = async () => (await admin`select 1 from pg_database where datname = ${name}`).length > 0;
    const refuse = () => new CutoverError(`database ${name} already exists; restore only into a new database`);
    if (await exists()) throw refuse();
    try {
      await admin.unsafe(`create database "${name}"`);
    } catch (error) {
      // duplicate_database: another session created it in between.
      if (error instanceof Error && 'code' in error && error.code === '42P04') throw refuse();
      throw error;
    }
    const marker = `peblish.cutover restore ${randomUUID()}`;
    await admin.unsafe(`comment on database "${name}" is '${marker}'`);
    return { url, name, marker };
  });
}

/**
 * Drops a database `restore` created in this process: refused when its comment is not the marker
 * written then, so a database someone else made or serves is never touched. WITH (FORCE) ends the
 * drill's own sessions only, since nothing else knows the name.
 */
export async function dropOwnDatabase(own: OwnDatabase): Promise<void> {
  await onServer(own.url, async (admin, name) => {
    if (name !== own.name) throw new CutoverError(`database ${name} is not the one this run created`);
    const [row] = await admin<{ marker: string | null }[]>`
      select shobj_description(oid, 'pg_database') as marker from pg_database where datname = ${name}`;
    if (!row) return;
    if (row.marker !== own.marker) throw new CutoverError(`database ${name} was not created by this run; it is left as it is`);
    await admin.unsafe(`drop database "${name}" with (force)`);
  });
}

/**
 * Creates the database `url` names, refusing one that exists, and restores `file` into it. A
 * restore that fails drops the half-restored database it created. Returns it, for the drill to drop.
 */
export async function restore(file: string, url: string): Promise<OwnDatabase> {
  const own = await createOwnDatabase(url);
  try {
    const { arg, env } = connection(url);
    await run(pgRestore(), ['--no-owner', '--no-privileges', '--exit-on-error', arg, file], env);
    return own;
  } catch (error) {
    await dropOwnDatabase(own);
    throw error;
  }
}

/** Drizzle on one connection to the database `url` names: the ledger, and core's block path for its replay. */
function connect(url: string) {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  return { db: drizzle({ client }), end: () => client.end({ timeout: 5 }) };
}

/** The transaction a replay runs in, with an outbox emit, as core's own block path expects. */
type ReplayTx = { readonly db: WriteTx; emit(event: OutboxEvent): Promise<void> };

async function readLedger(q: WriteTx): Promise<LedgerRow[]> {
  const rows = await q.select().from(deletionLedger).orderBy(asc(deletionLedger.id));
  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    subjectApId: row.subjectApId,
    reason: row.reason,
    requestedBy: row.requestedBy,
    details: row.details as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Every deletion_ledger row of the database `url` names, as a mode 600 JSON file. */
export async function exportLedger(url: string, file: string): Promise<number> {
  const { db, end } = connect(url);
  try {
    const rows = await db.transaction(readLedger);
    writePrivate(file, `${JSON.stringify({ format: 'peblish.ledger/1', exportedAt: new Date().toISOString(), rows }, null, 2)}\n`);
    return rows.length;
  } finally {
    await end();
  }
}

export function readLedgerExport(file: string): LedgerRow[] {
  return readJsonFile(file, 'the ledger export', LedgerExport).rows;
}

const remote = (row: LedgerRow) => row.details.remote === true;

/** The admin who made the change, when the backup has them (a list entry's added_by is a foreign key). */
async function adminInBackup(t: ReplayTx, row: LedgerRow): Promise<Uuid | null> {
  if (!row.requestedBy) return null;
  const [by] = await t.db.select({ id: actors.id }).from(actors).where(eq(actors.id, row.requestedBy));
  return (by?.id as Uuid | undefined) ?? null;
}

/** A list change's hash, which its row must name: without it the restore stops rather than guess. */
function hashOf(row: LedgerRow): string {
  if (typeof row.details.sha256 === 'string') return row.details.sha256;
  throw new CutoverError(`ledger row ${row.id}: ${row.reason} names no hash; stop and look before going live`);
}

/**
 * The hash half of a media block, through core's listBlockedHash: the hash goes back on the list
 * and every clean copy the backup holds is quarantined again, whether or not the blocked row
 * itself is in the backup. A row written before the ledger named the hash falls back to the
 * restored media row's hash and the category of its evidence. The copies' incidents start now,
 * so an admin gets the whole undecided window for them again. Returns how many it quarantined.
 */
async function replayBlockedHash(t: ReplayTx, row: LedgerRow): Promise<number> {
  const { details } = row;
  const [stored] = await t.db.select({ sha256: media.sha256 }).from(media).where(eq(media.id, row.subjectId));
  const sha256 = typeof details.sha256 === 'string' ? details.sha256 : (stored?.sha256 ?? null);
  if (sha256 === null) return 0;
  let category = blockCategories.find((known) => known === details.category);
  if (!category && typeof details.evidenceId === 'string') {
    const [evidence] = await t.db
      .select({ source: mediaEvidence.source, classification: mediaEvidence.classification })
      .from(mediaEvidence)
      .where(eq(mediaEvidence.id, details.evidenceId));
    if (evidence) category = categoryOf(evidence);
  }
  const { quarantinedCopies } = await listBlockedHash(t, {
    action: 'media.scan',
    sha256,
    category: category ?? 'other',
    by: await adminInBackup(t, row),
    now: new Date(),
  });
  return quarantinedCopies;
}

/**
 * A hash an admin listed by hand (mediascan/list.ts): back on the list with its category and
 * reason, and every clean copy the backup holds quarantined under it, as adding it did. The
 * copies' incidents start now. Its subject is the list entry, which exists afterwards.
 */
async function replayHashAdded(t: ReplayTx, row: LedgerRow): Promise<number> {
  const { quarantinedCopies } = await listBlockedHash(t, {
    action: 'media.blocklist',
    sha256: hashOf(row),
    category: blockCategories.find((known) => known === row.details.category) ?? 'other',
    reason: typeof row.details.reason === 'string' ? row.details.reason : null,
    by: await adminInBackup(t, row),
    now: new Date(),
  });
  return quarantinedCopies;
}

/**
 * Brings one ledger row's state change back, as the write that recorded it made it (identity/
 * delete.ts, remote/actors.ts, remote/objects.ts, inbound Delete and Undo, mediascan/block.ts and
 * list.ts).
 * Returns whether its subject exists here; throws on a reason it does not know, so a restore stops
 * instead of skipping a deletion.
 */
async function apply(t: ReplayTx, row: LedgerRow, tally: { quarantinedCopies: number }): Promise<boolean> {
  const q = t.db;
  const at = row.createdAt;
  const id = row.subjectId;
  const hit = async (statement: SQL) => (await q.execute(statement)).count > 0;
  switch (`${row.subjectKind}:${row.reason}`) {
    case 'post:remote.object_deleted':
    case 'post:remote.object_gone':
      return hit(sql`update posts set deleted_at = coalesce(deleted_at, ${at}::timestamptz) where id = ${id}`);
    case 'comment:remote.object_deleted':
    case 'comment:remote.object_gone':
      return hit(sql`update comments set deleted_at = coalesce(deleted_at, ${at}::timestamptz) where id = ${id}`);
    case 'post:remote.object_undeleted':
      return hit(sql`update posts set deleted_at = null where id = ${id}`);
    case 'comment:remote.object_undeleted':
      return hit(sql`update comments set deleted_at = null where id = ${id}`);
    case 'actor:remote.actor_deleted': {
      const found = await hit(sql`
        update actors set display_name = null, summary_html = null, icon_url = null, banner_url = null, posting_warning = null,
          raw = null, deleted_at = coalesce(deleted_at, ${at}::timestamptz)
        where id = ${id} and not local`);
      if (found && row.details.removeContent === true) {
        await q.execute(sql`update posts set deleted_at = coalesce(deleted_at, ${at}::timestamptz) where author_id = ${id}`);
        await q.execute(sql`update comments set deleted_at = coalesce(deleted_at, ${at}::timestamptz) where author_id = ${id}`);
      }
      return found;
    }
    case 'actor:remote.actor_undeleted':
      return hit(sql`update actors set deleted_at = null where id = ${id} and not local`);
    case 'media:media.blocked': {
      const found = await hit(
        sql`update media set scan_state = 'blocked', deleted_at = coalesce(deleted_at, ${at}::timestamptz) where id = ${id}`,
      );
      tally.quarantinedCopies += await replayBlockedHash(t, row);
      return found;
    }
    case 'media:media.hash_added':
      tally.quarantinedCopies += await replayHashAdded(t, row);
      return true;
    case 'media:media.hash_removed':
      // By value: a replayed listing may have given the hash a new entry id. Images it caught stay as they are, as on removal.
      return hit(sql`delete from media_blocklist where kind = 'sha256' and value = ${hashOf(row)}`);
  }
  // A local account deletion (identity/delete.ts): the reason is free text, the row is not remote.
  if (row.subjectKind === 'actor' && !remote(row) && typeof row.details.userId === 'string') {
    const found = await hit(sql`
      update actors set display_name = null, summary_html = null, summary_md = null, icon_url = null, banner_url = null,
        deleted_at = coalesce(deleted_at, ${at}::timestamptz)
      where id = ${id} and local`);
    await q.execute(sql`delete from auth_user where id = ${row.details.userId}`);
    return found;
  }
  throw new CutoverError(`ledger row ${row.id}: no rule for ${row.subjectKind} ${row.reason}; stop and add one before going live`);
}

export type ReapplyReport = { restoredRows: number; appended: number; applied: number; absent: number; quarantinedCopies: number };

/**
 * After a restore: appends the `exported` ledger rows the restored database lacks, keeping their
 * ids, then applies every ledger row in id order, in one transaction. Rows already in the
 * restored ledger are applied again too (each rule is idempotent), so the end state follows the
 * whole ledger whichever copy held a row. A subject the backup never had is counted as absent;
 * its row is kept, so the ledger stays whole. Events the replay emits (media.quarantined for the
 * copies a block catches) go to the restored database's outbox, and a purge of the whole edge
 * cache is owed.
 */
export async function reapplyLedger(url: string, exported: readonly LedgerRow[]): Promise<ReapplyReport> {
  const { db, end } = connect(url);
  try {
    return await db.transaction(async (q) => {
      const outbox = outboxEmitter(q);
      const t: ReplayTx = { db: q, emit: outbox.emit };
      const restored = await readLedger(q);
      const have = new Map(restored.map((row) => [row.id, row]));
      const missing = exported.filter((row) => !have.has(row.id));
      for (const row of exported) {
        const held = have.get(row.id);
        if (held && (held.subjectId !== row.subjectId || held.reason !== row.reason)) {
          throw new CutoverError(`ledger row ${row.id} differs between the backup and the export: they are not the same database`);
        }
      }
      for (const row of missing) {
        await q.execute(sql`
          insert into deletion_ledger (id, subject_kind, subject_id, subject_ap_id, reason, requested_by, details, created_at)
          overriding system value
          values (${row.id}, ${row.subjectKind}, ${row.subjectId}, ${row.subjectApId}, ${row.reason}, ${row.requestedBy},
            ${JSON.stringify(row.details)}::jsonb, ${row.createdAt}::timestamptz)`);
      }
      await q.execute(
        sql`select setval(pg_get_serial_sequence('deletion_ledger', 'id'), greatest((select max(id) from deletion_ledger), 1))`,
      );
      const tally = { quarantinedCopies: 0 };
      let applied = 0;
      let absent = 0;
      for (const row of await readLedger(q)) {
        if (await apply(t, row, tally)) applied += 1;
        else absent += 1;
      }
      // The edge may still hold images the replayed takedowns hid, and their events are gone:
      // web answers private until a purge of everything is sent (core edge/debt.ts).
      await owePurgeAfterRestore(q);
      await outbox.notify();
      return { restoredRows: restored.length, appended: missing.length, applied, absent, ...tally };
    });
  } finally {
    await end();
  }
}

/** Row counts of the tables a restore must bring back, for comparing a source and its restore. */
export async function tableCounts(url: string): Promise<Record<string, number>> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const tables = ['instances', 'actors', 'actor_keys', 'auth_user', 'follows', 'posts', 'comments', 'deletion_ledger', 'outbox'];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
      counts[table] = row?.n ?? 0;
    }
    return counts;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export type DrillReport = {
  backup: string;
  ledger: string;
  database: string;
  kept: boolean;
  reapplied: ReapplyReport;
  source: Record<string, number>;
  restored: Record<string, number>;
  differences: string[];
};

/**
 * The drill: back up the database `url` names into `dir`, export its ledger, restore into a new
 * database `drill_<time>_<random>` on the same server (created here, refused if it exists),
 * re-apply the ledger and compare row counts. The new database is dropped afterwards unless
 * `keep`; nothing else on the server is dropped or disconnected.
 */
export async function runDrill(url: string, dir: string, options: { keep?: boolean } = {}): Promise<DrillReport> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15).toLowerCase();
  const backupFile = join(dir, `backup-${stamp}.dump`);
  const ledger = join(dir, `ledger-${stamp}.json`);
  const target = new URL(url);
  target.pathname = `/drill_${stamp}_${randomBytes(3).toString('hex')}`;
  await backup(url, backupFile);
  await exportLedger(url, ledger);
  const own = await restore(backupFile, target.href);
  try {
    const reapplied = await reapplyLedger(own.url, readLedgerExport(ledger));
    const [source, restored] = [await tableCounts(url), await tableCounts(own.url)];
    const differences = Object.keys(source).filter((table) => source[table] !== restored[table]);
    return { backup: backupFile, ledger, database: own.name, kept: options.keep === true, reapplied, source, restored, differences };
  } finally {
    if (!options.keep) await dropOwnDatabase(own);
  }
}
