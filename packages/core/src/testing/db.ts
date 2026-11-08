import { sql } from 'drizzle-orm';
import { writer } from '../db/write.ts';

/** Empties every application table (the migrations journal lives in the drizzle schema). */
export async function truncateAll(): Promise<void> {
  const rows = await writer().execute<{ name: string }>(sql`select tablename as name from pg_tables where schemaname = 'public'`);
  if (rows.length === 0) return;
  const tables = rows.map(({ name }) => `"${name}"`).join(', ');
  await writer().execute(sql.raw(`truncate ${tables} restart identity cascade`));
}
