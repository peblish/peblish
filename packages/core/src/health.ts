import { sql } from 'drizzle-orm';
import { db } from './db/read.ts';

/**
 * Whether the database answers within `timeoutMs` (readiness probes). Never throws: a
 * missing or invalid DATABASE_URL is "not ready" too.
 */
export async function databaseReady(timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(resolve, timeoutMs, false)));
  const query = Promise.resolve()
    .then(() => db().execute(sql`select 1`))
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
