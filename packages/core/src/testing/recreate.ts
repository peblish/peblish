import postgres from 'postgres';
import { runMigrations } from '../db/migrate.ts';

/** Runs `statements` on the server's maintenance database against the test database `url` names. */
async function onServer(url: URL, statements: (name: string) => string[]): Promise<void> {
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to touch ${name}: test databases end in _test`);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => {} });
  try {
    for (const statement of statements(name)) await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

/** Drops and recreates the test database `url` names, then applies every migration unless `migrate` is false. */
export async function recreateDatabase(url: URL, { migrate = true } = {}): Promise<void> {
  await onServer(url, (name) => [`drop database if exists "${name}" with (force)`, `create database "${name}"`]);
  if (migrate) await runMigrations(url.href);
}

/** Drops the test database `url` names. */
export const dropDatabase = (url: URL) => onServer(url, (name) => [`drop database if exists "${name}" with (force)`]);
