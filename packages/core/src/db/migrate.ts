import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** The SQL migrations shipped with core (copied into the image next to the bundle). */
export const migrationsFolder = process.env.PEBLISH_MIGRATIONS_DIR ?? join(import.meta.dirname, '../../drizzle');

/** Applies pending migrations to `url` on a dedicated connection. */
export async function runMigrations(url: string, folder = migrationsFolder): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
