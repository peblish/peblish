import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, test } from 'vitest';
import { readPool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { seedBulk } from '../testing/seed-c1.ts';
import { seedInstance } from '../testing/seed.ts';
import { defaultQuery, directorySorts, nsfwModes, scopes, type DirectoryQuery } from './input.ts';
import { listCommunities } from './read.ts';

// The directory's budget: the first page of every sort and filter under 50 ms at the 95th
// percentile over 20 runs, at 300 communities and C1's 100,000 posts, with the activity count
// reading `posts_community_published`. Opt-in, as C1's feed target is (it seeds 100,000 rows and a
// timing is not a check for a shared CI machine):
//   PEBLISH_DIRECTORY_PERF=1 [DIRECTORY_PERF_PLANS=<file>] [DIRECTORY_PERF_REPORT=<file>] pnpm exec vitest run --project core packages/core/src/directory/perf.test.ts

const runs = 20;
const budgetMs = 50;
const percentile95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

describe.skipIf(!process.env.PEBLISH_DIRECTORY_PERF)('directory performance', () => {
  let viewer: { actorId: string; declared: true };
  beforeAll(async () => {
    const local = await seedInstance('feddit.test');
    const { heavy } = await seedBulk({ local });
    // Local communities for the NSFW filter to find, and a figure for the sorts to order by.
    await writer().execute(sql`update actors set sensitive = true where local and kind = 'Group' and name in ('c30', 'c60')`);
    await writer().execute(sql`analyze`);
    viewer = { actorId: heavy.id, declared: true };
  }, 300_000);

  test(`the first page of every sort, scope and NSFW setting answers in under ${budgetMs} ms (p95 of ${runs})`, async () => {
    const slow: string[] = [];
    const report: string[] = [];
    const searches = ['', 'c1', 'r12.test'];
    for (const sort of directorySorts)
      for (const scope of scopes)
        for (const nsfw of nsfwModes)
          for (const q of searches) {
            const query: DirectoryQuery = { ...defaultQuery, sort, scope, nsfw, q };
            const timings: number[] = [];
            for (let run = 0; run < runs + 1; run += 1) {
              const began = performance.now();
              await listCommunities(query, viewer);
              if (run > 0) timings.push(performance.now() - began);
            }
            const p95 = percentile95(timings);
            report.push(`${sort} / ${scope} / ${nsfw} / "${q}": p95 ${p95.toFixed(1)} ms`);
            if (p95 > budgetMs) slow.push(report.at(-1)!);
          }
    if (process.env.DIRECTORY_PERF_REPORT) writeFileSync(process.env.DIRECTORY_PERF_REPORT, report.join('\n'));
    expect(slow).toEqual([]);
  }, 600_000);

  test('the activity count reads posts_community_published', async () => {
    const plan = await readPool().client.unsafe(
      `explain select count(distinct author_id) from posts where community_id = (select id from actors where name = 'c1') and published_at > now() - interval '7 days' and deleted_at is null and removed_at is null`,
    );
    const text = plan.map((row) => String(row['QUERY PLAN'])).join('\n');
    if (process.env.DIRECTORY_PERF_PLANS) writeFileSync(process.env.DIRECTORY_PERF_PLANS, text);
    expect(text).toContain('posts_community_published');
  });
});
