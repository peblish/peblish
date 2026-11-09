import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// `pnpm e2e [playwright arguments]`: the parallel project, then the serial one (*.serial.spec.ts),
// as two Playwright runs. A project dependency would skip the serial specs whenever a parallel
// spec failed; two runs in a row still never put a serial spec beside a parallel one. The exit
// status is the parallel run's when it failed, else the serial run's, and both are printed.
// Arguments go to both runs; arguments that name a --project make one run, as given.

const config = join(import.meta.dirname, 'playwright.config.ts');
const args = process.argv.slice(2);

/** One Playwright run; E2E_PHASE keeps each run's results and report apart (playwright.config.ts). */
function playwright(phase: string, extra: readonly string[]): number {
  const run = spawnSync('playwright', ['test', '-c', config, ...extra, ...args], {
    stdio: 'inherit',
    env: { ...process.env, E2E_PHASE: phase },
  });
  // Interrupted (Ctrl-C): stop here rather than start the next run.
  if (run.signal) process.exit(130);
  return run.status ?? 1;
}

if (args.some((arg) => arg === '--project' || arg.startsWith('--project='))) {
  process.exitCode = playwright('chosen', []);
} else {
  // A file filter can leave either project with nothing to run, which is not a failure.
  const parallel = playwright('parallel', ['--project', 'chromium', '--pass-with-no-tests']);
  const serial = playwright('serial', ['--project', 'serial', '--pass-with-no-tests']);
  console.log(`e2e: parallel run exited ${parallel}, serial run exited ${serial}`);
  process.exitCode = parallel !== 0 ? parallel : serial;
}
