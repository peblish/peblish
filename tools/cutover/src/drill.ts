import { spawn } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import { type } from 'arktype';
import postgres from 'postgres';
import { openPrivate, writePrivate } from './bundle.ts';

// The backup and restore drill (T&S baseline: a restore drill that re-applies the deletion
// ledger). A backup is `pg_dump -Fc`; the ledger is also exported on its own, more often than
// backups (deploy/cutover.md), because a restore loses every row written after its backup,
// ledger rows included. After `pg_restore` into a new database, `reapplyLedger` appends the
// exported rows the backup lacks (keeping their ids) and then applies every ledger row in id
// order, so nothing deleted before the incident comes back. Files are written with mode 600.

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

function run(binary: string, args: string[], env: NodeJS.ProcessEnv, stdout: 'ignore' | number = 'ignore'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', stdout, 'pipe'], env });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}: ${err.trim().slice(0, 2000)}`))));
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

async function onServer(url: string, statement: (name: string) => string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`database name ${name} must be lowercase letters, digits and underscores`);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(statement(name));
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Creates the database `url` names (it must not exist) and restores `file` into it. */
export async function restore(file: string, url: string): Promise<void> {
  await onServer(url, (name) => `create database "${name}"`);
  const { arg, env } = connection(url);
  await run(pgRestore(), ['--no-owner', '--no-privileges', '--exit-on-error', arg, file], env);
}

export async function dropDatabase(url: string): Promise<void> {
  await onServer(url, (name) => `drop database if exists "${name}" with (force)`);
}

async function readLedger(sql: Sql | postgres.TransactionSql): Promise<LedgerRow[]> {
  const rows = await sql<
    {
      id: string;
      subject_kind: LedgerRow['subjectKind'];
      subject_id: string;
      subject_ap_id: string | null;
      reason: string;
      requested_by: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }[]
  >`select id, subject_kind, subject_id, subject_ap_id, reason, requested_by, details, created_at from deletion_ledger order by id`;
  return rows.map((row) => ({
    id: Number(row.id),
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectApId: row.subject_ap_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    details: row.details,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Every deletion_ledger row of the database `url` names, as a mode 600 JSON file. */
export async function exportLedger(url: string, file: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const rows = await readLedger(sql);
    writePrivate(file, `${JSON.stringify({ format: 'peblish.ledger/1', exportedAt: new Date().toISOString(), rows }, null, 2)}\n`);
    return rows.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function readLedgerExport(file: string): LedgerRow[] {
  return LedgerExport.assert(JSON.parse(readFileSync(file, 'utf8'))).rows;
}

const remote = (row: LedgerRow) => row.details.remote === true;

/**
 * Brings one ledger row's state change back, as the write that recorded it made it (identity/
 * delete.ts, remote/actors.ts, remote/objects.ts, inbound Delete and Undo, mediascan/block.ts).
 * Returns whether its subject exists here; throws on a reason it does not know, so a restore stops
 * instead of skipping a deletion.
 */
async function apply(q: postgres.TransactionSql, row: LedgerRow): Promise<boolean> {
  const at = new Date(row.createdAt);
  const id = row.subjectId;
  const hit = (result: { count: number }) => result.count > 0;
  switch (`${row.subjectKind}:${row.reason}`) {
    case 'post:remote.object_deleted':
    case 'post:remote.object_gone':
      return hit(await q`update posts set deleted_at = coalesce(deleted_at, ${at}) where id = ${id}`);
    case 'comment:remote.object_deleted':
    case 'comment:remote.object_gone':
      return hit(await q`update comments set deleted_at = coalesce(deleted_at, ${at}) where id = ${id}`);
    case 'post:remote.object_undeleted':
      return hit(await q`update posts set deleted_at = null where id = ${id}`);
    case 'comment:remote.object_undeleted':
      return hit(await q`update comments set deleted_at = null where id = ${id}`);
    case 'actor:remote.actor_deleted': {
      const found = hit(
        await q`
        update actors set display_name = null, summary_html = null, icon_url = null, banner_url = null, posting_warning = null,
          raw = null, deleted_at = coalesce(deleted_at, ${at})
        where id = ${id} and not local`,
      );
      if (found && row.details.removeContent === true) {
        await q`update posts set deleted_at = coalesce(deleted_at, ${at}) where author_id = ${id}`;
        await q`update comments set deleted_at = coalesce(deleted_at, ${at}) where author_id = ${id}`;
      }
      return found;
    }
    case 'actor:remote.actor_undeleted':
      return hit(await q`update actors set deleted_at = null where id = ${id} and not local`);
    case 'media:media.blocked':
      return hit(await q`update media set scan_state = 'blocked', deleted_at = coalesce(deleted_at, ${at}) where id = ${id}`);
  }
  // A local account deletion (identity/delete.ts): the reason is free text, the row is not remote.
  if (row.subjectKind === 'actor' && !remote(row) && typeof row.details.userId === 'string') {
    const found = hit(
      await q`
      update actors set display_name = null, summary_html = null, summary_md = null, icon_url = null, banner_url = null,
        deleted_at = coalesce(deleted_at, ${at})
      where id = ${id} and local`,
    );
    await q`delete from auth_user where id = ${row.details.userId}`;
    return found;
  }
  throw new Error(`ledger row ${row.id}: no rule for ${row.subjectKind} ${row.reason}; stop and add one before going live`);
}

export type ReapplyReport = { restoredRows: number; appended: number; applied: number; absent: number };

/**
 * After a restore: appends the `exported` ledger rows the restored database lacks, keeping their
 * ids, then applies every ledger row in id order, in one transaction. Rows already in the
 * restored ledger are applied again too (each rule is idempotent), so the end state follows the
 * whole ledger whichever copy held a row. A subject the backup never had is counted as absent;
 * its row is kept, so the ledger stays whole.
 */
export async function reapplyLedger(url: string, exported: readonly LedgerRow[]): Promise<ReapplyReport> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (q) => {
      const restored = await readLedger(q);
      const have = new Map(restored.map((row) => [row.id, row]));
      const missing = exported.filter((row) => !have.has(row.id));
      for (const row of exported) {
        const held = have.get(row.id);
        if (held && (held.subjectId !== row.subjectId || held.reason !== row.reason)) {
          throw new Error(`ledger row ${row.id} differs between the backup and the export: they are not the same database`);
        }
      }
      for (const row of missing) {
        await q`
          insert into deletion_ledger (id, subject_kind, subject_id, subject_ap_id, reason, requested_by, details, created_at)
          overriding system value
          values (${row.id}, ${row.subjectKind}, ${row.subjectId}, ${row.subjectApId}, ${row.reason}, ${row.requestedBy},
            ${q.json(row.details as postgres.JSONValue)}, ${new Date(row.createdAt)})`;
      }
      await q`select setval(pg_get_serial_sequence('deletion_ledger', 'id'), greatest((select max(id) from deletion_ledger), 1))`;
      let applied = 0;
      let absent = 0;
      for (const row of await readLedger(q)) {
        if (await apply(q, row)) applied += 1;
        else absent += 1;
      }
      return { restoredRows: restored.length, appended: missing.length, applied, absent };
    });
  } finally {
    await sql.end({ timeout: 5 });
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
