import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, test } from 'vitest';
import { readPool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { seedBulk } from '../testing/seed-c1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { seedInstance } from '../testing/seed.ts';
import { decodeCursor } from './cursor.ts';
import { periods, type FeedName } from './input.ts';
import { followedCommunities, keyQueries, readFeed, type FeedRequest } from './read.ts';

// The performance target (C1): 100,000 posts over 90 days in 300 communities, a viewer
// following 130 of them; every feed and sort, first page and tenth page, under 50 ms at the
// 95th percentile over 20 runs, with the key query on an index of `posts`. Three kinds of
// viewer: no blocks, E1's blocker (100 people, 50 communities and 20 instances, following the
// same 130 communities) and, in a second pass, a site with 25 blocked peers (M18; feddit.com
// starts with about 25 banned instances): 22 that hold nothing and 3 of the 40 that hold posts.
//
// Opt-in, because it seeds 100,000 rows and a timing is not a check for a shared CI machine:
//   PEBLISH_FEED_PERF=1 [FEED_PERF_PLANS=<file>] pnpm exec vitest run --project core packages/core/src/feeds/perf.test.ts
// The indexes are the migrations' own (`posts_score`, `actors_gated` in 0005): the database is
// migrated like production's, and the plan check below fails if a sort or a gate loses its index.

const runs = 20;
const budgetMs = 50;

type Viewer = { actorId: string; siteRole: 'user' } | null;
type Case = { who: string; viewer: Viewer; feed: FeedName };

const percentile95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

describe.skipIf(!process.env.PEBLISH_FEED_PERF)('feed performance', () => {
  const cases: Case[] = [];
  const peerCases: Case[] = [];
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
    const user = (person: { id: string }): Viewer => ({ actorId: person.id, siteRole: 'user' });
    // E1: a viewer with 100 person blocks, 50 community blocks and 20 instance blocks (S02).
    const blocker = await seedPerson(local, 'blocker');
    await writer().execute(
      sql`insert into person_blocks select ${blocker.id}::uuid, id from actors where kind = 'Person' and not local order by random() limit 100`,
    );
    await writer().execute(
      sql`insert into community_blocks select ${blocker.id}::uuid, id from actors where kind = 'Group' order by random() limit 50`,
    );
    await writer().execute(
      sql`insert into instance_blocks select ${blocker.id}::uuid, id from instances where not local order by random() limit 20`,
    );
    await writer().execute(
      sql`insert into follows (id, follower_id, followee_id, state, accepted_at)
        select gen_random_uuid(), ${blocker.id}::uuid, followee_id, state, accepted_at from follows where follower_id = ${heavy.id}::uuid`,
    );
    // Statistics as a running site has them, blocks and follows included.
    await writer().execute(sql`analyze`);
    cases.push(
      { who: 'signed out', viewer: null, feed: 'all' },
      { who: 'signed out', viewer: null, feed: 'local' },
      { who: 'signed out', viewer: null, feed: 'popular' },
      { who: 'follows 130', viewer: user(heavy), feed: 'subscribed' },
      { who: 'follows 130', viewer: user(heavy), feed: 'all' },
      { who: 'follows 3 quiet', viewer: user(sparse), feed: 'subscribed' },
      { who: 'moderates 2', viewer: user(moderator), feed: 'moderating' },
      { who: 'blocks 100/50/20', viewer: user(blocker), feed: 'all' },
      { who: 'blocks 100/50/20', viewer: user(blocker), feed: 'local' },
      { who: 'blocks 100/50/20', viewer: user(blocker), feed: 'subscribed' },
    );
    peerCases.push(
      { who: '25 peers blocked, signed out', viewer: null, feed: 'all' },
      { who: '25 peers blocked, signed out', viewer: null, feed: 'popular' },
      { who: '25 peers blocked, follows 130', viewer: user(heavy), feed: 'subscribed' },
      { who: '25 peers blocked, follows 130', viewer: user(heavy), feed: 'all' },
      { who: '25 peers blocked, blocks 100/50/20', viewer: user(blocker), feed: 'all' },
      { who: '25 peers blocked, blocks 100/50/20', viewer: user(blocker), feed: 'subscribed' },
    );
  }, 300_000);

  /** The site's peer blocks for the second pass: 22 instances that hold nothing, and 3 of the 40 that hold posts. */
  async function blockPeers() {
    await writer().execute(sql`
      insert into instances (id, domain, origin, local, software)
      select gen_random_uuid(), 'banned' || s.i || '.test', 'https://banned' || s.i || '.test', false, 'lemmy' from generate_series(1, 22) as s(i)`);
    await writer().execute(sql`
      insert into peer_controls (instance_id, blocked)
      select id, true from instances where domain like 'banned%' or domain in ('r7.test', 'r19.test', 'r33.test')`);
    await writer().execute(sql`analyze`);
  }

  test(`every feed and sort answers in under ${budgetMs} ms (p95 of ${runs}), first page and tenth, on an index scan`, async () => {
    const slow: string[] = [];
    const measure = async ({ who, viewer, feed }: Case) => {
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
            `${label.padEnd(64)} ${position.padEnd(8)} p50 ${[...timings]
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
          const followed = viewer && feed === 'subscribed' ? await followedCommunities(readPool().db, viewer) : undefined;
          const [first] = keyQueries({ ...reading, followed });
          const { sql: text, params } = first!(21).toSQL();
          const plan = (await readPool().client.unsafe(`explain (analyze, buffers) ${text}`, params as never[]))
            .map((row) => String(row['QUERY PLAN']))
            .join('\n');
          plans.push(`== ${label} / ${position}\n${plan}`);
          expect(plan, `${label} ${position}`).not.toMatch(/Seq Scan on posts/);
        }
      }
    };
    for (const c of cases) await measure(c);
    await blockPeers();
    for (const c of peerCases) await measure(c);
    console.log(report.join('\n'));
    if (process.env.FEED_PERF_PLANS) {
      writeFileSync(process.env.FEED_PERF_PLANS, plans.join('\n\n'));
      writeFileSync(`${process.env.FEED_PERF_PLANS}.timings`, report.join('\n'));
    }
    expect(slow).toEqual([]);
  }, 1_800_000);
});
