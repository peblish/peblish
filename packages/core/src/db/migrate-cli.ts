import { databaseUrl } from '../config.ts';
import { ensureLocalInstance } from './bootstrap.ts';
import { runMigrations } from './migrate.ts';
import { closePools } from './pools.ts';
import { writer } from './write.ts';

// `migrate` command: applies pending migrations, then creates the local instance row when
// PUBLIC_ORIGIN is set.
await runMigrations(databaseUrl());
console.log('migrations applied');
if (process.env.PUBLIC_ORIGIN) {
  await ensureLocalInstance(writer(), process.env.PUBLIC_ORIGIN);
  console.log(`local instance: ${new URL(process.env.PUBLIC_ORIGIN).host}`);
  await closePools();
}
