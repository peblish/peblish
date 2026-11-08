import type { TestProject } from 'vitest/node';
import { recreateDatabase } from '../packages/core/src/testing/recreate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** The lane's test database: scripts/lane.sh prints it, CI sets it. No default, so a lane never drops another's. */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is unset: run lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env" first');
  return url;
}

/** Recreates the test database from the migrations once per run, as a fresh Postgres would see them. */
export default async function setup(project: TestProject) {
  const url = testDatabaseUrl();
  await recreateDatabase(new URL(url));
  project.provide('databaseUrl', url);
}
