import { sql } from 'drizzle-orm';
import { writer } from '../db/write.ts';

/** Truncate guards on the append-only tables, suspended (as their owner) only while emptying them. */
const truncateGuards = [
  ['modlog', 'modlog_no_truncate'],
  ['deletion_ledger', 'deletion_ledger_no_truncate'],
] as const;

/** Empties every application table (the migrations journal lives in the drizzle schema). */
export async function truncateAll(): Promise<void> {
  await writer().transaction(async (t) => {
    const rows = await t.execute<{ name: string }>(sql`select tablename as name from pg_tables where schemaname = 'public'`);
    if (rows.length === 0) return;
    for (const [table, trigger] of truncateGuards) await t.execute(sql.raw(`alter table "${table}" disable trigger "${trigger}"`));
    await t.execute(sql.raw(`truncate ${rows.map(({ name }) => `"${name}"`).join(', ')} restart identity cascade`));
    for (const [table, trigger] of truncateGuards) await t.execute(sql.raw(`alter table "${table}" enable trigger "${trigger}"`));
  });
}
