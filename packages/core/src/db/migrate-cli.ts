import { databaseUrl, publicOrigin } from '../config.ts';
import { ensureLocalInstance, ensureSettingRows } from './bootstrap.ts';
import { runMigrations } from './migrate.ts';
import { closePools } from './pools.ts';
import { writer } from './write.ts';

// `migrate` command: applies pending migrations, then creates the local instance row when
// PUBLIC_ORIGIN is set, both under the migrate lock, after writing the default rows of the
// settings policies lock.
try {
  await runMigrations(databaseUrl(), {
    async after() {
      console.log('migrations applied');
      await ensureSettingRows(writer());
      const origin = publicOrigin();
      if (!origin) return;
      await ensureLocalInstance(writer(), origin);
      console.log(`local instance: ${new URL(origin).host}`);
    },
  });
} finally {
  await closePools();
}
