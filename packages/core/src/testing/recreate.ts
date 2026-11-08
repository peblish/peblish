import postgres from 'postgres';
import { runMigrations } from '../db/migrate.ts';

/** Drops and recreates the database `url` names, then applies every migration to it. */
export async function recreateDatabase(url: URL): Promise<void> {
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to recreate ${name}: test databases end in _test`);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  await runMigrations(url.href);
}
