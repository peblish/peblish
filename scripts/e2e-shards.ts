// The e2e shards' test counts (CI). Each shard of `pnpm e2e` (E2E_SHARD=<i>/<n>, e2e/run.ts)
// writes one ShardCounts file; `node scripts/e2e-shards.ts <dir>` reads every file in <dir> and
// fails unless the shards 1 to n each reported once and together ran the whole suite. A shard
// that selects no test exits 0 in Playwright, so without this a typo could skip half the suite.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Shard {
  current: number;
  total: number;
}

/** Tests per Playwright project: `parallel` is the chromium project, `serial` the *.serial.spec.ts one. */
export interface ProjectCounts {
  parallel: number;
  serial: number;
}

export interface ShardCounts {
  shard: string;
  /** The whole suite as listed on this shard, before sharding. */
  suite: ProjectCounts;
  /** The tests this shard ran: passed, failed, flaky and skipped. */
  ran: ProjectCounts;
}

/** `<current>/<total>`, 1-based, as Playwright's --shard takes it. */
export function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const [current, total] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (current < 1 || total < 1 || current > total) throw new Error(`E2E_SHARD "${value}" is not <current>/<total>, such as 1/2`);
  return { current, total };
}

/** What is wrong with a set of shard reports; empty when they add up to the whole suite. */
export function shardProblems(reports: readonly ShardCounts[]): string[] {
  if (reports.length === 0) return ['no shard reported its counts'];
  const problems: string[] = [];
  const shards = reports.map(({ shard }) => parseShard(shard));
  const total = shards[0]!.total;
  if (shards.some((shard) => shard.total !== total))
    problems.push(`the shards disagree on their number: ${reports.map(({ shard }) => shard).join(', ')}`);
  for (let current = 1; current <= total; current++) {
    const seen = shards.filter((shard) => shard.current === current).length;
    if (seen !== 1) problems.push(`shard ${current}/${total} reported ${seen} times`);
  }
  const { suite } = reports[0]!;
  if (reports.some((report) => report.suite.parallel !== suite.parallel || report.suite.serial !== suite.serial))
    problems.push('the shards listed different suites');
  if (suite.parallel + suite.serial === 0) problems.push('the suite lists no tests');
  for (const { shard, ran } of reports) if (ran.parallel + ran.serial === 0) problems.push(`shard ${shard} ran no tests`);
  for (const project of ['parallel', 'serial'] as const) {
    const ran = reports.reduce((sum, report) => sum + report.ran[project], 0);
    if (ran !== suite[project]) problems.push(`the ${project} project ran ${ran} of ${suite[project]} tests across the shards`);
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/e2e-shards.ts <directory of shard counts>');
  const reports: ShardCounts[] = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  for (const { shard, ran } of reports) console.log(`e2e shard ${shard}: ${ran.parallel} parallel, ${ran.serial} serial`);
  const problems = shardProblems(reports);
  for (const problem of problems) console.error(`e2e shards: ${problem}`);
  if (problems.length === 0) {
    const { suite } = reports[0]!;
    console.log(`e2e shards: together they ran the whole suite (${suite.parallel} parallel, ${suite.serial} serial)`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}
