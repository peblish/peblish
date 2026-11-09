import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, test } from 'vitest';
import { readPool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { seedBulk } from '../testing/seed-c1.ts';
import { seedInstance } from '../testing/seed.ts';
import { decodeCursor } from './cursor.ts';
import { periods, type FeedName } from './input.ts';
import { keyQueries, readFeed, type FeedRequest } from './read.ts';

// The performance target (C1): 100,000 posts over 90 days in 300 communities, a viewer
// following 130 of them; every feed and sort, first page and tenth page, under 50 ms at the
// 95th percentile over 20 runs, with the key query on an index of `posts`.
//
// Opt-in, because it seeds 100,000 rows and a timing is not a check for a shared CI machine:
//   PEBLISH_FEED_PERF=1 [FEED_PERF_PLANS=<file>] pnpm exec vitest run --project core packages/core/src/feeds/perf.test.ts
// The indexes below are the ones lane C1 asks root to add to `posts` and `actors` (LANE-NOTES);
// the test creates them in the test database when the migrations do not have them yet.

const runs = 20;
const budgetMs = 50;

const indexes = [
  'create index if not exists posts_score on posts (((upvotes - downvotes)) desc nulls last, id desc nulls last)',
  'create index if not exists actors_gated on actors (id) where sensitive or nsfl',
];

type Viewer = { actorId: string; siteRole: 'user' } | null;
type Case = { who: string; viewer: Viewer; feed: FeedName };

const percentile95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

describe.skipIf(!process.env.PEBLISH_FEED_PERF)('feed performance', () => {
  const cases: Case[] = [];
  const sorts: Pick<FeedRequest, 'sort' | 'period'>[] = [
    { sort: 'hot' },
    { sort: 'new' },
    { sort: 'old' },
    ...periods.map((period) => ({ sort: 'top' as const, period })),
  ];
  const report: string[] = [];
  const plans: string[] = [];

  beforeAll(async () => {
    const local = await seedInstance('feddit.test');
    const { heavy, sparse, moderator } = await seedBulk({ local });
    for (const statement of indexes) await writer().execute(sql.raw(statement));
    await writer().execute(sql`analyze`);
    const user = (person: { id: string }): Viewer => ({ actorId: person.id, siteRole: 'user' });
    cases.push(
      { who: 'signed out', viewer: null, feed: 'all' },
      { who: 'signed out', viewer: null, feed: 'local' },
      { who: 'signed out', viewer: null, feed: 'popular' },
      { who: 'follows 130', viewer: user(heavy), feed: 'subscribed' },
      { who: 'follows 130', viewer: user(heavy), feed: 'all' },
      { who: 'follows 3 quiet', viewer: user(sparse), feed: 'subscribed' },
      { who: 'moderates 2', viewer: user(moderator), feed: 'moderating' },
    );
  }, 300_000);

  test(`every feed and sort answers in under ${budgetMs} ms (p95 of ${runs}), first page and tenth, on an index scan`, async () => {
    const slow: string[] = [];
    for (const { who, viewer, feed } of cases) {
      for (const { sort, period } of sorts) {
        const request = { feed, sort, ...(period ? { period } : {}) } satisfies FeedRequest;
        const label = `${who} / ${feed} / ${sort}${period ? `:${period}` : ''}`;
        // The cursor of the tenth page: walk the nine before it once.
        let cursor: string | undefined;
        for (let page = 1; page < 10; page += 1) {
          const result = await readFeed({ ...request, cursor }, viewer);
          cursor = result.next ?? undefined;
          if (!cursor) break;
        }
        for (const [position, start] of [
          ['page 1', undefined],
          ['page 10', cursor],
        ] as const) {
          if (position === 'page 10' && !start) continue;
          const timings: number[] = [];
          for (let run = 0; run < runs + 1; run += 1) {
            const began = performance.now();
            await readFeed({ ...request, cursor: start }, viewer);
            // The first run warms the connection and the cache.
            if (run > 0) timings.push(performance.now() - began);
          }
          const p95 = percentile95(timings);
          report.push(
            `${label.padEnd(52)} ${position.padEnd(8)} p50 ${[...timings]
              .sort((a, b) => a - b)[9]!
              .toFixed(1)
              .padStart(5)} ms  p95 ${p95.toFixed(1).padStart(5)} ms`,
          );
          if (p95 >= budgetMs) slow.push(`${label} ${position}: ${p95.toFixed(1)} ms`);

          // The plan of the key query, on a position after `start`: it must not read `posts` in sequence.
          const decoded = decodeCursor(start);
          const reading = {
            q: readPool().db,
            feed,
            sort,
            period: period ?? 'all',
            viewer,
            asOf: decoded?.asOf ?? Date.now(),
            cursor: decoded,
          } as const;
          const [first] = keyQueries(reading);
          const { sql: text, params } = first!(21).toSQL();
          const plan = (await readPool().client.unsafe(`explain (analyze, buffers) ${text}`, params as never[]))
            .map((row) => String(row['QUERY PLAN']))
            .join('\n');
          plans.push(`== ${label} / ${position}\n${plan}`);
          expect(plan, `${label} ${position}`).not.toMatch(/Seq Scan on posts/);
        }
      }
    }
    console.log(report.join('\n'));
    if (process.env.FEED_PERF_PLANS) writeFileSync(process.env.FEED_PERF_PLANS, plans.join('\n\n'));
    expect(slow).toEqual([]);
  }, 1_800_000);
});
