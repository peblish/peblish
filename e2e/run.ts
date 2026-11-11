import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShard, type ShardCounts } from '../scripts/e2e-shards.ts';

// `pnpm e2e [playwright arguments]`: the parallel project, then the serial one (*.serial.spec.ts),
// as two Playwright runs. A project dependency would skip the serial specs whenever a parallel
// spec failed; two runs in a row still never put a serial spec beside a parallel one. The exit
// status is the parallel run's when it failed, else the serial run's, and both are printed.
// Arguments go to both runs; arguments that name a --project make one run, as given.
//
// E2E_SHARD=<i>/<n> (CI, one runner each) runs part i of n of the parallel project by Playwright's
// --shard, which never splits a spec file, so the payload budget runs whole on one shard. Only
// the last shard runs the serial project: a file that straddles the cut goes to the earlier
// shard, so the last one has the smallest part. Each shard writes its counts to
// artifacts/counts/shard-<i>.json, and scripts/e2e-shards.ts checks they add up to the suite.

const config = join(import.meta.dirname, 'playwright.config.ts');
const artifacts = join(import.meta.dirname, 'artifacts');
const args = process.argv.slice(2);
const shard = process.env.E2E_SHARD ? parseShard(process.env.E2E_SHARD) : undefined;

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

interface Suite {
  specs: { tests: unknown[] }[];
  suites?: Suite[];
}
const countTests = (suites: Suite[] = []): number =>
  suites.reduce((sum, suite) => sum + suite.specs.reduce((n, spec) => n + spec.tests.length, 0) + countTests(suite.suites), 0);

/** The project's tests before sharding and without the arguments: the whole suite. */
function listed(project: string): number {
  const list = spawnSync('playwright', ['test', '-c', config, '--list', `--project=${project}`, '--reporter=json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, E2E_PHASE: 'list' },
  });
  if (list.status !== 0) throw new Error(`playwright --list --project=${project} exited ${list.status}: ${list.stderr}`);
  return countTests(JSON.parse(list.stdout).suites);
}

/** The tests a run reported in its JSON results (playwright.config.ts writes them when E2E_SHARD is set); 0 for a run that did not happen. */
function ran(phase: string): number {
  const file = join(artifacts, 'results', `${phase}.json`);
  if (!existsSync(file)) return 0;
  const { expected, unexpected, flaky, skipped } = JSON.parse(readFileSync(file, 'utf8')).stats;
  return expected + unexpected + flaky + skipped;
}

if (args.some((arg) => arg === '--project' || arg.startsWith('--project='))) {
  if (shard) throw new Error('E2E_SHARD shards both projects: drop --project, or unset E2E_SHARD');
  process.exitCode = playwright('chosen', []);
} else if (shard) {
  // A results file from an earlier local run would count for a run this shard skips.
  rmSync(join(artifacts, 'results'), { recursive: true, force: true });
  // No --pass-with-no-tests: the shard runs its part of the whole suite, never nothing.
  const parallel = playwright('parallel', ['--project=chromium', `--shard=${shard.current}/${shard.total}`]);
  const last = shard.current === shard.total;
  const serial = last ? playwright('serial', ['--project=serial']) : 0;
  const counts: ShardCounts = {
    shard: `${shard.current}/${shard.total}`,
    suite: { parallel: listed('chromium'), serial: listed('serial') },
    ran: { parallel: ran('parallel'), serial: ran('serial') },
  };
  mkdirSync(join(artifacts, 'counts'), { recursive: true });
  writeFileSync(join(artifacts, 'counts', `shard-${shard.current}.json`), `${JSON.stringify(counts, null, 2)}\n`);
  console.log(
    `e2e shard ${counts.shard}: parallel run exited ${parallel} after ${counts.ran.parallel} of ${counts.suite.parallel} tests, ` +
      (last
        ? `serial run exited ${serial} after ${counts.ran.serial} of ${counts.suite.serial}`
        : 'the serial project runs on the last shard'),
  );
  const empty = counts.ran.parallel === 0 || (last && counts.ran.serial === 0);
  if (empty) console.error(`e2e shard ${counts.shard}: a run had no tests`);
  process.exitCode = parallel !== 0 ? parallel : serial !== 0 ? serial : empty ? 1 : 0;
} else {
  // A file filter can leave either project with nothing to run, which is not a failure.
  const parallel = playwright('parallel', ['--project', 'chromium', '--pass-with-no-tests']);
  const serial = playwright('serial', ['--project', 'serial', '--pass-with-no-tests']);
  console.log(`e2e: parallel run exited ${parallel}, serial run exited ${serial}`);
  process.exitCode = parallel !== 0 ? parallel : serial;
}
