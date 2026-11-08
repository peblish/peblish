import { databaseUrl, publicOrigin } from '../config.ts';
import { ensureLocalInstance } from './bootstrap.ts';
import { runMigrations } from './migrate.ts';
import { closePools } from './pools.ts';
import { writer } from './write.ts';

// `migrate` command: applies pending migrations, then creates the local instance row when
// PUBLIC_ORIGIN is set.
await runMigrations(databaseUrl());
console.log('migrations applied');
const origin = publicOrigin();
if (origin) {
  await ensureLocalInstance(writer(), origin);
  console.log(`local instance: ${new URL(origin).host}`);
  await closePools();
}
