import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** The SQL migrations shipped with core (copied into the image next to the bundle). */
export const migrationsFolder = process.env.PEBLISH_MIGRATIONS_DIR ?? join(import.meta.dirname, '../../drizzle');

/**
 * The database has a migration applied that this build's folder does not contain, older than
 * the folder's newest: it was migrated from other migration files (a lane database migrated
 * before 0001 was regenerated, say). Drizzle would otherwise try to re-apply them and fail
 * on the first existing table. Applied migrations newer than every file are a newer build's,
 * which a rollback may meet; those pass.
 */
export class MigrationHistoryError extends Error {
  override readonly name = 'MigrationHistoryError';
}

async function assertHistory(client: postgres.Sql, folder: string): Promise<void> {
  const [journal] = await client<{ exists: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!journal?.exists) return;
  const files = readMigrationFiles({ migrationsFolder: folder });
  const known = new Set(files.map(({ hash }) => hash));
  const newest = Math.max(0, ...files.map(({ folderMillis }) => folderMillis));
  const applied = await client<
    { hash: string; createdAt: string }[]
  >`select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations`;
  const foreign = applied.filter(({ hash, createdAt }) => !known.has(hash) && Number(createdAt) <= newest);
  if (foreign.length > 0) {
    throw new MigrationHistoryError(
      `this database was migrated from different migration files: ${foreign.length} applied migration(s) are not in ${folder}. ` +
        'Recreate the database, or migrate it from the build that created it.',
    );
  }
}

export type MigrateOptions = {
  folder?: string;
  /** Runs after the migrations while the lock is still held: the instance bootstrap. */
  after?: () => Promise<void>;
};

/**
 * Applies pending migrations to `url` on a dedicated connection that holds the database's
 * migrate advisory lock throughout, then runs `after`. Two migrate processes started together
 * (a rollout with several replicas) run one after the other instead of racing on the journal
 * and the DDL; the second finds nothing pending. A database whose applied migrations diverge
 * from the folder's throws MigrationHistoryError before anything runs.
 */
export async function runMigrations(url: string, { folder = migrationsFolder, after }: MigrateOptions = {}): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(hashtext('peblish.migrate'))`;
    try {
      await assertHistory(client, folder);
      await migrate(drizzle({ client }), { migrationsFolder: folder });
      await after?.();
    } finally {
      await client`select pg_advisory_unlock(hashtext('peblish.migrate'))`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
