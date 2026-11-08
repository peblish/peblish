import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** The SQL migrations shipped with core (copied into the image next to the bundle). */
export const migrationsFolder = process.env.PEBLISH_MIGRATIONS_DIR ?? join(import.meta.dirname, '../../drizzle');

export type MigrateOptions = {
  folder?: string;
  /** Runs after the migrations while the lock is still held: the instance bootstrap. */
  after?: () => Promise<void>;
};

/**
 * Applies pending migrations to `url` on a dedicated connection that holds the database's
 * migrate advisory lock throughout, then runs `after`. Two migrate processes started together
 * (a rollout with several replicas) run one after the other instead of racing on the journal
 * and the DDL; the second finds nothing pending.
 */
export async function runMigrations(url: string, { folder = migrationsFolder, after }: MigrateOptions = {}): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(hashtext('peblish.migrate'))`;
    try {
      await migrate(drizzle({ client }), { migrationsFolder: folder });
      await after?.();
    } finally {
      await client`select pg_advisory_unlock(hashtext('peblish.migrate'))`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
