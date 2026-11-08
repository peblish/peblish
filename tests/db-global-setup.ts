import type { TestProject } from 'vitest/node';
import { recreateDatabase } from '../packages/core/src/testing/recreate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** The lane's test database (scripts/lane.sh prints it); G0's by default. */
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://peblish:peblish@127.0.0.1:18432/peblish_g0_test';

/** Recreates the test database from the migrations once per run, as a fresh Postgres would see them. */
export default async function setup(project: TestProject) {
  await recreateDatabase(new URL(testDatabaseUrl));
  project.provide('databaseUrl', testDatabaseUrl);
}
