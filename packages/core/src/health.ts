import { sql } from 'drizzle-orm';
import { db } from './db/read.ts';

let configurationReported = false;

/**
 * Whether the database answers within `timeoutMs` (readiness probes). Never throws: a
 * missing or invalid DATABASE_URL is "not ready" too, and is logged once per process, since
 * unlike an outage it never heals by itself. An unreachable database is not logged here.
 */
export async function databaseReady(timeoutMs = 2_000): Promise<boolean> {
  let handle: ReturnType<typeof db>;
  try {
    handle = db();
  } catch (error) {
    if (!configurationReported) {
      configurationReported = true;
      console.error('readiness: the database is not configured:', error instanceof Error ? error.message : error);
    }
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(resolve, timeoutMs, false)));
  const query = handle.execute(sql`select 1`).then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
