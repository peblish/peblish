import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Starts every run with empty throttle counters. The specs that fail a sign-in on purpose leave
 * 9 of the 10 a client address may make in 15 minutes, so a second run soon after the first can
 * be refused ("Too many attempts") on a lane database. CI databases are fresh, so this only
 * serves repeated local runs. Against a remote BASE_URL there is no database to reach.
 */
export default function globalSetup() {
  if (process.env.BASE_URL) return;
  execFileSync('node', ['e2e/support/reset-throttles.ts'], { cwd: join(import.meta.dirname, '..') });
}
