import { sql } from 'drizzle-orm';
import { db } from './db/read.ts';

/** Whether the database answers within `timeoutMs` (readiness probes). */
export async function databaseReady(timeoutMs = 2_000): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => setTimeout(resolve, timeoutMs, false));
  const query = db()
    .execute(sql`select 1`)
    .then(() => true, () => false);
  return Promise.race([query, timeout]);
}
