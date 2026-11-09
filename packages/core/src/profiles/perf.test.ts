import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, test } from 'vitest';
import { readPool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { seedBulk } from '../testing/seed-c1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { seedInstance } from '../testing/seed.ts';
import type { ProfileSort, ProfileTab } from './input.ts';
import { activityQueries, readActivity } from './read.ts';

// Opt-in, like the feed's (feeds/perf.test.ts), because it seeds 100,000 posts first:
//   PEBLISH_FEED_PERF=1 pnpm exec vitest run --project core packages/core/src/profiles/perf.test.ts
// A prolific author (5,000 posts, 20,000 comments) must be read through both author indexes, with
// the viewer's blocks applied, in every tab and sort. The timings are printed; the plans are asserted.
// `comments_author_published` is the index the profile wants (root adds it to migration 0007 at
// integration); the test creates it when the database does not have it yet. The planner may still
// prefer the plain `comments_author` for a viewer who hides most of what the author wrote, so
// either author index passes; a sequential scan of `posts` or `comments` never does.

const runs = 20;
const budgetMs = 50;
const percentile95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

describe.skipIf(!process.env.PEBLISH_FEED_PERF)('profile activity performance', () => {
  let author: { id: string };
  let viewer: { actorId: string; siteRole: 'user' };

  beforeAll(async () => {
    const local = await seedInstance('feddit.test');
    await seedBulk({ local });
    author = await seedPerson(local, 'prolific');
    const reader = await seedPerson(local, 'reader');
    viewer = { actorId: reader.id, siteRole: 'user' };
    const w = writer();
    await w.execute(sql`
      insert into posts (id, ap_id, local, instance_id, author_id, community_id, title, published_at, upvotes, downvotes)
      select gen_random_uuid(), 'https://feddit.test/post/prolific' || s.i, true, ${local.id}::uuid, ${author.id}::uuid,
             (select id from actors where kind = 'Group' and name = 'c' || (1 + s.i % 300)),
             'Prolific ' || s.i, now() - s.i * interval '15 minutes', floor(random() * 50)::int, floor(random() * 5)::int
      from generate_series(1, 5000) as s(i)`);
    // 20,000 comments by the author and 150,000 by other people, each on a post drawn at random
    // (a join on a row number: a scalar sub-select would be drawn once for every row).
    const comment = (authorSql: ReturnType<typeof sql>, count: number, label: string) =>
      w.execute(sql`
        with ps as (select id, row_number() over () as n from posts),
             total as (select count(*)::int as n from posts),
             c as (select gen_random_uuid() as id, s.i, 1 + floor(random() * (select n from total))::int as n from generate_series(1, ${count}::int) as s(i))
        insert into comments (id, ap_id, local, instance_id, post_id, author_id, path, body_md, published_at, upvotes, downvotes)
        select c.id, ${label}::text || c.id, true, ${local.id}::uuid, ps.id, ${authorSql},
               replace(c.id::text, '-', '_')::ltree, 'A comment ' || c.i, now() - c.i * interval '4 minutes', floor(random() * 30)::int, floor(random() * 3)::int
        from c join ps on ps.n = c.n`);
    await comment(sql`${author.id}::uuid`, 20_000, 'https://feddit.test/comment/mine/');
    await comment(
      sql`(select id from actors where kind = 'Person' and name = 'u' || (1 + floor(random() * 2000))::int limit 1)`,
      150_000,
      'https://feddit.test/comment/other/',
    );
    await w.execute(sql`create index if not exists comments_author_published on comments (author_id, published_at desc)`);
    // The reader blocks as many as the feed's blocker does.
    await w.execute(
      sql`insert into person_blocks select ${reader.id}::uuid, id from actors where kind = 'Person' and not local order by random() limit 100`,
    );
    await w.execute(
      sql`insert into community_blocks select ${reader.id}::uuid, id from actors where kind = 'Group' order by random() limit 50`,
    );
    await w.execute(
      sql`insert into instance_blocks select ${reader.id}::uuid, id from instances where not local order by random() limit 20`,
    );
    await w.execute(sql`analyze`);
  }, 600_000);

  test('every tab and sort reads through the author indexes', async () => {
    const report: string[] = [];
    for (const tab of ['overview', 'posts', 'comments'] as ProfileTab[]) {
      for (const sort of ['new', 'top'] as ProfileSort[]) {
        const request = { personId: author.id, tab, sort } as const;
        const timings: number[] = [];
        for (let run = 0; run < runs + 1; run += 1) {
          const began = performance.now();
          await readActivity(request, viewer);
          if (run > 0) timings.push(performance.now() - began);
        }
        report.push(`${tab.padEnd(9)} ${sort.padEnd(4)} p95 ${percentile95(timings).toFixed(1).padStart(6)} ms`);

        const queries = activityQueries(request, viewer);
        const explain = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
          const { sql: text, params } = query.toSQL();
          return (await readPool().client.unsafe(`explain (analyze, buffers) ${text}`, params as never[]))
            .map((row) => String(row['QUERY PLAN']))
            .join('\n');
        };
        if (tab !== 'comments') {
          const plan = await explain(queries.posts);
          expect(plan, `${tab} ${sort} posts`).not.toMatch(/Seq Scan on posts/);
          expect(plan, `${tab} ${sort} posts`).toMatch(/(Index|Bitmap Index) Scan (using|on) posts_author/);
        }
        if (tab !== 'posts') {
          const plan = await explain(queries.comments);
          expect(plan, `${tab} ${sort} comments`).not.toMatch(/Seq Scan on comments/);
          expect(plan, `${tab} ${sort} comments`).toMatch(/(Index|Bitmap Index) Scan (using|on) comments_author/);
        }
      }
    }
    console.log(report.join('\n'));
    if (process.env.FEED_PERF_PLANS) writeFileSync(process.env.FEED_PERF_PLANS, report.join('\n'));
    // The newest-first pages are the ones everybody opens; they must fit the feed's budget too.
    expect(report.filter((line) => / new /.test(line) && Number(/p95\s+([\d.]+)/.exec(line)?.[1]) >= budgetMs)).toEqual([]);
  }, 600_000);
});
