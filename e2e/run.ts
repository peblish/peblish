import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShard, reportFlaky, type FlakyTest, type ShardCounts } from '../scripts/e2e-shards.ts';

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
// A shard also lists its flaky tests (failed, then passed on CI's retry) in the log and the job
// summary, and writes them to artifacts/results/flaky.txt, which tells CI to upload the artifacts.

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

/** Playwright's JSON report, as far as this reads it. */
interface Suite {
  title: string;
  specs: { title: string; file: string; line: number; tests: { status: string }[] }[];
  suites?: Suite[];
}
interface Results {
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  suites: Suite[];
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

/** A run's JSON results (playwright.config.ts writes them when E2E_SHARD is set); undefined for a run that did not happen. */
function results(phase: string): Results | undefined {
  const file = join(artifacts, 'results', `${phase}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Results) : undefined;
}

/** The tests a run reported: passed, failed, flaky and skipped. */
function ran(run: Results | undefined): number {
  if (!run) return 0;
  const { expected, unexpected, flaky, skipped } = run.stats;
  return expected + unexpected + flaky + skipped;
}

/** The tests whose outcome was flaky: failed, then passed on the retry. The top-level suites are files, so their titles are left out. */
function flaky(suites: Suite[] = [], describes?: string[]): FlakyTest[] {
  return suites.flatMap((suite) => {
    const titles = describes ? [...describes, suite.title] : [];
    const own = suite.specs
      .filter((spec) => spec.tests.some((test) => test.status === 'flaky'))
      .map(({ file, line, title }) => ({ file, line, title: [...titles, title].join(' › ') }));
    return [...own, ...flaky(suite.suites, titles)];
  });
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
  const runs = { parallel: results('parallel'), serial: results('serial') };
  const counts: ShardCounts = {
    shard: `${shard.current}/${shard.total}`,
    suite: { parallel: listed('chromium'), serial: listed('serial') },
    ran: { parallel: ran(runs.parallel), serial: ran(runs.serial) },
    flaky: [...flaky(runs.parallel?.suites), ...flaky(runs.serial?.suites)],
  };
  mkdirSync(join(artifacts, 'counts'), { recursive: true });
  writeFileSync(join(artifacts, 'counts', `shard-${shard.current}.json`), `${JSON.stringify(counts, null, 2)}\n`);
  console.log(
    `e2e shard ${counts.shard}: parallel run exited ${parallel} after ${counts.ran.parallel} of ${counts.suite.parallel} tests, ` +
      (last
        ? `serial run exited ${serial} after ${counts.ran.serial} of ${counts.suite.serial}`
        : 'the serial project runs on the last shard'),
  );
  reportFlaky(`Flaky in shard ${counts.shard}`, counts.flaky);
  // CI uploads the artifacts (the failed attempts' traces) when this file exists, as when a run failed.
  if (counts.flaky.length > 0)
    writeFileSync(
      join(artifacts, 'results', 'flaky.txt'),
      counts.flaky.map(({ file, line, title }) => `${file}:${line} ${title}\n`).join(''),
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
