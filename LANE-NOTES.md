# Lane C1 notes (wave 2)

Feeds: plan rows D01 (Subscribed, Local, All, Popular, Moderating), D02 (Hot), D04 (New and Old) and D05 (Top by period), plus the shell's community lists. Branch `mvp-w2-c1` from `mvp-w2` at e886daf, port 18313, database `peblish_c1` (the 100,000 post world lives in `peblish_c1_perf`, created by hand for the measurements).

## 1. What landed

| Deliverable                                                                                                                   | Where                                                                                               | Proof                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed read model: five feeds, Hot, New, Old, Top (eight periods), keyset pages, every registered `feedPredicate`               | `c/feeds/{input,cursor,read}.ts`                                                                    | `c/feeds/read.test.ts` (18): membership per feed, predicate registry, order of each sort, Hot against hand-computed ranks, stability of every sort across an insert between page loads (six requests) |
| Cursor: opaque, ArkType-validated, carries sort, period, `asOf`, the last row's date (microseconds) and id, and score or rank | `c/feeds/cursor.ts`                                                                                 | `read.test.ts`: a cursor of another sort or period, or a garbled one, starts at the first page; mutation check: dropping the id from the date keyset fails the stability test                         |
| Sidebar lists: followed communities (local and remote, pending included), moderating count, local list when signed out        | `c/feeds/shell.ts`, `w/shell/data.ts`                                                               | `c/feeds/shell.test.ts` (3); `e2e/feeds` (sidebar of a viewer)                                                                                                                                        |
| Feed pages `/`, `/all`, `/local`, `/popular`, `/moderating`: toolbar, density, cards, votes, next page                        | `w/routes/index.tsx`, `w/routes/{all,local,popular,moderating}/index.tsx`, `w/routes/index/-feed/*` | `e2e/feeds/feeds.spec.ts` (16): hydration and axe on each route, sorts, Top periods, density, next pages in order, votes, the gate, German, no JavaScript; `-feed/feed-search.test.ts` (3)            |
| Strings                                                                                                                       | `w/i18n/feeds.json` (en, de)                                                                        | catalogue parity test in `feed-search.test.ts`; German e2e with axe                                                                                                                                   |
| Test seeds                                                                                                                    | `c/testing/seed-c1.ts`: `seedFeedWorld`, `seedBulk`, and the CLI `e2e` and `bulk`                   | used by the tests above                                                                                                                                                                               |
| Performance target                                                                                                            | `c/feeds/perf.test.ts` (opt-in), section 3                                                          | section 3                                                                                                                                                                                             |

(`c/` is `packages/core/src/`, `w/` is `packages/web/src/`.)

## 2. Commits

| Commit  | Change                                                                        |
| ------- | ----------------------------------------------------------------------------- |
| 932738e | Add the feed read model: five feeds, four sorts and keyset pagination         |
| 2d1043f | Fill the sidebar's community lists from the follows and the local communities |
| 86050cc | Add the home, all, local, popular and moderating feed pages                   |
| b7b1202 | Add the feeds end-to-end spec and its seed                                    |
| 4d30946 | Add the opt-in feed performance test: 100,000 posts, every feed and sort      |
| 498a632 | Write the performance test's timings beside its plans                         |
| (this)  | These notes                                                                   |

Nothing in this lane needs to merge early.

## 3. Verification

On this tree, lane `c1` (`PEBLISH_UI_KIT=1`):

- `pnpm install --frozen-lockfile`: up to date, no lockfile change. No dependency added. `git diff e886daf.. -- packages/core/drizzle` is empty: no migration.
- `pnpm check`: green, 103 test files passed and 2 skipped, 1,505 tests passed and 3 skipped (baseline 1,481 passed: +24 are `read.test.ts` 18, `shell.test.ts` 3 and `feed-search.test.ts` 3; the extra skip is the opt-in performance test). Boundaries clean (522 modules), oxlint and Prettier clean.
- `pnpm e2e` on port 18313: 115 passed, 1 skipped (the test that `/kit` answers 404 where the gallery is off, which needs a server without `PEBLISH_UI_KIT`). Wave 2's 99 plus the 16 in `e2e/feeds`.
- Mutation check on the pagination test: dropping the id from the date keyset (`(published_at) < ...` for `(published_at, id) < ...`) fails `new: pages join up ...`; restored.
- Axe by hand on `/` and `/all` in Card, Classic and Compact (and true black): clean after the title margin (4.16), as the e2e spec runs it in Classic and in German.

### Payload (first visit, cold cache, gzip -9, as `e2e/payload` measures it; routes.ts temporarily had `/all`, then reverted: request 5.4)

| Route  | React and Mux JS (budget 170) | Mux CSS (budget 65) | Fonts (budget 270) |
| ------ | ----------------------------- | ------------------- | ------------------ |
| `/`    | 62.8 kB                       | 60.4 kB             | 105.6 kB           |
| `/all` | 62.8 kB                       | 60.4 kB             | 105.6 kB           |

The feed route adds 3.3 kB of script (1.3 kB gzip) and 0.9 kB of CSS outside what the budget counts. `/all`'s document is 68.8 kB raw, 6.8 kB gzip, for twenty cards (the dehydrated loader data is in it); `/` signed out is 21.2 kB, 4.3 kB gzip.

### The performance target

Seeded by `seedBulk` (`PEBLISH_FEED_PERF=1 pnpm exec vitest run --project core packages/core/src/feeds/perf.test.ts`): 100,000 posts over 90 days in 300 communities (10 local, 290 remote on 40 instances, a skewed share of posts per community: 180 to 2,872, median 268), 1% deleted, 1% removed, 1.5% sensitive, a long tail of scores, 2,050 authors. Viewers: signed out; one who follows 130 remote communities; one who follows the three quietest; one who moderates two. Per case (every feed, every sort, Top in all eight periods; 133 measured cases), one warm-up and then 20 timed runs of `readFeed` end to end (key query, rows by id, `postViews`), page 1 and page 10 (a cursor walked nine pages deep), on a Postgres 17 container shared with the other lanes, the two indexes of section 5 in place. A case passes when its p95 is under 50 ms and its key query's plan has no `Seq Scan on posts`.

| Run                                   | Load average (18 cores) | Median p95 | p90 of the p95s | Worst p95                                         |
| ------------------------------------- | ----------------------- | ---------- | --------------- | ------------------------------------------------- |
| A, while other lanes ran their suites | 25 to 27                | 7.2 ms     | 24.7 ms         | 45.1 ms (Local, New, page 10; 5 ms of query time) |
| B, the plans and timings below        | 19 to 22                | 5.1 ms     | 10.2 ms         | 23.5 ms (All, Hot, page 10)                       |

Both runs passed (and so did the one before them, whose report I did not keep, at load 15: no p95 over 25 ms). Before the `posts_score` index (request 5.1), on the quiet machine, the same harness gave: signed-out All Top by month 39 ms (p50, page 1) and 51 ms (page 10), by year 159 and 188 ms, all time 155 and 182 ms; Popular's tenth page by year or all time 549 ms; follows-130 Subscribed Top by year or all time 40 ms. The plan for All, Top, all time without it: `Seq Scan on posts` (96,505 rows, 52 ms), `Sort Method: top-N heapsort`, JIT 11.9 ms, 150 ms; with it: `Index Scan using posts_score`, 0.1 ms.

How to read the matrix (run B, every statement's `EXPLAIN (ANALYZE)` plan is in the test's `FEED_PERF_PLANS` file): each cell is `index(es) of posts the key query used: execution time in ms of the key query on page 1 (p95 of the end-to-end readFeed in parentheses) / the same on page 10`; a dash is a case with fewer than ten pages. `pub` is `posts_published`, `comm` is `posts_community_published`, `score` is `posts_score`.

| viewer / feed               | hot                                      | new                             | old                             | top:1h                | top:6h                               | top:12h                                   | top:day                              | top:week                                | top:month                             | top:year                               | top:all                                |
| --------------------------- | ---------------------------------------- | ------------------------------- | ------------------------------- | --------------------- | ------------------------------------ | ----------------------------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------------- |
| signed out, all             | pub: 16.060 (17.3) / 16.569 (23.5)       | pub: 0.085 (4.4) / 0.088 (4.6)  | pub: 0.094 (4.6) / 0.092 (5.4)  | pub: 0.293 (5.0) / -  | pub+score: 0.600 (4.4) / 1.894 (6.5) | pub+score: 0.948 (6.8) / 3.006 (7.7)      | pub+score: 1.609 (6.1) / 5.013 (9.8) | score: 0.256 (6.0) / 0.357 (5.1)        | score: 0.132 (4.5) / 0.097 (4.4)      | score: 0.071 (4.1) / 0.073 (3.5)       | score: 0.107 (4.4) / 0.078 (5.6)       |
| signed out, local           | comm: 0.510 (4.7) / 0.446 (5.3)          | comm: 4.452 (7.7) / 3.313 (7.7) | comm: 3.541 (8.3) / 4.535 (7.2) | comm: 0.041 (1.3) / - | comm: 0.073 (3.7) / -                | comm: 0.077 (4.3) / -                     | comm: 0.096 (4.6) / -                | comm+score: 0.481 (4.0) / 11.148 (15.7) | comm: 1.359 (5.5) / 1.263 (5.7)       | comm: 3.789 (9.4) / 5.403 (11.9)       | comm: 4.566 (9.1) / 6.107 (10.2)       |
| signed out, popular         | pub+score: 11.645 (18.2) / 14.355 (23.4) | pub: 0.085 (5.2) / 0.109 (4.1)  | pub: 0.098 (4.7) / 0.103 (4.2)  | pub: 0.357 (5.0) / -  | pub: 0.472 (4.4) / -                 | pub+score: 2.971 (7.4) / 1.526 (6.5)      | pub+score: 3.248 (7.9) / 2.796 (7.5) | score: 0.230 (5.7) / 0.257 (3.6)        | score: 0.103 (4.4) / 0.073 (5.0)      | score: 0.069 (3.9) / 0.087 (5.1)       | score: 0.106 (3.7) / 0.142 (5.1)       |
| follows 130, subscribed     | comm: 5.051 (11.1) / 6.013 (12.3)        | pub: 0.183 (4.6) / 0.157 (5.4)  | pub: 0.180 (4.8) / 0.144 (5.0)  | comm: 0.378 (5.4) / - | comm: 0.549 (5.9) / -                | comm+pub+score: 0.800 (5.7) / 1.169 (5.9) | comm: 0.944 (6.6) / 0.872 (5.0)      | comm: 4.704 (8.3) / 3.987 (9.7)         | comm: 17.299 (20.4) / 18.559 (22.2)   | score: 0.202 (4.0) / 0.136 (3.9)       | score: 0.157 (4.0) / 0.144 (4.0)       |
| follows 130, all            | pub: 11.579 (21.7) / 16.577 (20.1)       | pub: 0.100 (5.8) / 0.098 (4.8)  | pub: 0.087 (4.9) / 0.098 (4.6)  | pub: 0.241 (5.4) / -  | pub+score: 0.620 (5.4) / 1.567 (7.5) | pub+score: 1.269 (5.4) / 3.089 (9.1)      | pub+score: 1.746 (7.1) / 4.708 (9.5) | score: 0.250 (5.7) / 0.364 (5.0)        | score: 0.089 (4.5) / 0.084 (4.4)      | score: 0.070 (4.1) / 0.072 (4.0)       | score: 0.069 (3.7) / 0.066 (4.2)       |
| follows 3 quiet, subscribed | comm: 0.122 (4.3) / 0.494 (4.4)          | comm: 0.741 (5.8) / 0.545 (4.8) | comm: 0.964 (5.6) / 0.496 (4.9) | comm: 0.027 (1.0) / - | comm: 0.043 (3.6) / -                | comm: 0.043 (4.0) / -                     | comm: 0.052 (4.0) / -                | comm: 0.107 (4.5) / -                   | comm: 0.250 (4.2) / -                 | comm+score: 0.683 (4.2) / 7.480 (14.4) | comm+score: 0.712 (5.3) / 7.422 (12.4) |
| moderates 2, moderating     | comm: 0.152 (4.3) / 0.789 (5.1)          | comm: 0.997 (4.7) / 0.752 (4.5) | comm: 1.123 (6.5) / 1.207 (5.6) | comm: 0.030 (1.1) / - | comm: 0.039 (3.2) / -                | comm: 0.062 (4.2) / -                     | comm: 0.060 (5.0) / -                | comm: 0.201 (6.1) / -                   | comm+score: 0.521 (5.1) / 3.086 (9.0) | comm: 1.034 (7.5) / 1.092 (6.2)        | comm: 1.162 (10.0) / 0.913 (6.3)       |

Four of the plans, as Postgres ran them (asOf values replaced by `<asOf>`):

`signed out / all / hot / page 1` (EXPLAIN (ANALYZE, BUFFERS) of the key query, the statement the page runs first):

```
Limit  (cost=71296.02..71297.86 rows=21 width=52) (actual time=16.021..16.027 rows=21 loops=1)
  Buffers: shared hit=5548
  ->  Result  (cost=71296.02..71338.02 rows=480 width=52) (actual time=16.020..16.025 rows=21 loops=1)
        Buffers: shared hit=5548
        ->  Sort  (cost=71296.02..71297.22 rows=480 width=52) (actual time=16.019..16.022 rows=21 loops=1)
              Sort Key: (hot rank) DESC, posts.published_at DESC NULLS LAST, posts.id DESC
              Sort Method: top-N heapsort  Memory: 29kB
              Buffers: shared hit=5548
              ->  Nested Loop Anti Join  (cost=183.93..71283.08 rows=480 width=52) (actual time=1.081..15.340 rows=7518 loops=1)
                    Join Filter: (community_removals.community_id = posts.community_id)
                    Buffers: shared hit=5548
                    ->  Nested Loop  (cost=183.93..71256.66 rows=482 width=48) (actual time=1.069..9.434 rows=7518 loops=1)
                          Buffers: shared hit=5548
                          ->  Bitmap Heap Scan on posts  (cost=183.64..71056.35 rows=3779 width=48) (actual time=1.045..7.147 rows=7518 loops=1)
                                Recheck Cond: ((published_at <= <asOf>) AND (published_at > <asOf>))
                                Filter: ((deleted_at IS NULL) AND (removed_at IS NULL) AND (NOT sensitive) AND (NOT nsfl) AND (NOT (ANY (community_id = (hashed SubPlan 2).col1))))
                                Rows Removed by Filter: 279
                                Heap Blocks: exact=4624
                                Buffers: shared hit=4648
                                ->  Bitmap Index Scan on posts_published  (cost=0.00..182.70 rows=7840 width=0) (actual time=0.672..0.673 rows=7797 loops=1)
                                      Index Cond: ((published_at <= <asOf>) AND (published_at > <asOf>))
                                      Buffers: shared hit=23
                                SubPlan 2
                                  ->  Index Only Scan using actors_gated on actors gated_community  (cost=0.12..8.14 rows=1 width=16) (actual time=0.078..0.078 rows=0 loops=1)
                                        Heap Fetches: 0
                                        Buffers: shared hit=1
                          ->  Memoize  (cost=0.29..0.36 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=7518)
                                Cache Key: posts.community_id
                                Cache Mode: logical
                                Hits: 7218  Misses: 300  Evictions: 0  Overflows: 0  Memory Usage: 38kB
                                Buffers: shared hit=900
                                ->  Index Scan using actors_pkey on actors open_community  (cost=0.28..0.35 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=300)
                                      Index Cond: (id = posts.community_id)
                                      Filter: ((deleted_at IS NULL) AND (kind = 'Group'::text))
                                      Buffers: shared hit=900
                    ->  Seq Scan on community_removals  (cost=0.00..0.00 rows=1 width=16) (actual time=0.000..0.000 rows=0 loops=7518)
Execution Time: 16.060 ms
```

`signed out / all / new / page 10` (EXPLAIN (ANALYZE, BUFFERS) of the key query, the statement the page runs first):

```
Limit  (cost=138.99..3045.61 rows=21 width=44) (actual time=0.070..0.071 rows=21 loops=1)
  Buffers: shared hit=88
  ->  Incremental Sort  (cost=138.99..844859.81 rows=6103 width=44) (actual time=0.069..0.070 rows=21 loops=1)
        Sort Key: posts.published_at DESC NULLS LAST, posts.id DESC
        Presorted Key: posts.published_at
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
        Buffers: shared hit=88
        ->  Nested Loop Anti Join  (cost=0.59..844585.17 rows=6103 width=44) (actual time=0.016..0.065 rows=22 loops=1)
              Join Filter: (community_removals.community_id = posts.community_id)
              Buffers: shared hit=88
              ->  Nested Loop  (cost=0.59..844447.61 rows=6123 width=48) (actual time=0.012..0.052 rows=22 loops=1)
                    Buffers: shared hit=88
                    ->  Index Scan using posts_published on posts  (cost=0.30..843155.81 rows=48023 width=48) (actual time=0.008..0.028 rows=22 loops=1)
                          Index Cond: ((published_at <= <asOf>) AND (published_at <= <asOf>) AND (published_at <= <asOf>))
                          Filter: ((deleted_at IS NULL) AND (removed_at IS NULL) AND (NOT sensitive) AND (NOT nsfl) AND (ROW(published_at, id) < ROW(<asOf>, 'cb3b3067-e99f-49cc-a5c6-774ea84f01f3'::uuid)) AND (NOT (ANY (community_id = (hashed SubPlan 2).col1))))
                          Rows Removed by Filter: 3
                          Buffers: shared hit=28
                          SubPlan 2
                            ->  Index Only Scan using actors_gated on actors gated_community  (cost=0.12..8.14 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=1)
                                  Heap Fetches: 0
                                  Buffers: shared hit=1
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=22)
                          Cache Key: posts.community_id
                          Cache Mode: logical
                          Hits: 2  Misses: 20  Evictions: 0  Overflows: 0  Memory Usage: 3kB
                          Buffers: shared hit=60
                          ->  Index Scan using actors_pkey on actors open_community  (cost=0.28..0.30 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=20)
                                Index Cond: (id = posts.community_id)
                                Filter: ((deleted_at IS NULL) AND (kind = 'Group'::text))
                                Buffers: shared hit=60
              ->  Seq Scan on community_removals  (cost=0.00..0.00 rows=1 width=16) (actual time=0.000..0.000 rows=0 loops=22)
Execution Time: 0.088 ms
```

`signed out / all / top:all / page 1` (EXPLAIN (ANALYZE, BUFFERS) of the key query, the statement the page runs first):

```
Limit  (cost=0.71..2900.25 rows=21 width=36) (actual time=0.027..0.095 rows=21 loops=1)
  Buffers: shared hit=86
  ->  Nested Loop Anti Join  (cost=0.71..845839.23 rows=6126 width=36) (actual time=0.027..0.094 rows=21 loops=1)
        Join Filter: (community_removals.community_id = posts.community_id)
        Buffers: shared hit=86
        ->  Nested Loop  (cost=0.71..845701.14 rows=6146 width=48) (actual time=0.023..0.078 rows=21 loops=1)
              Buffers: shared hit=86
              ->  Index Scan using posts_score on posts  (cost=0.42..844404.78 rows=48206 width=48) (actual time=0.011..0.040 rows=21 loops=1)
                    Filter: ((deleted_at IS NULL) AND (removed_at IS NULL) AND (NOT sensitive) AND (NOT nsfl) AND (published_at <= <asOf>) AND (NOT (ANY (community_id = (hashed SubPlan 2).col1))))
                    Rows Removed by Filter: 1
                    Buffers: shared hit=26
                    SubPlan 2
                      ->  Index Only Scan using actors_gated on actors gated_community  (cost=0.12..8.14 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=1)
                            Heap Fetches: 0
                            Buffers: shared hit=1
              ->  Memoize  (cost=0.29..0.31 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=21)
                    Cache Key: posts.community_id
                    Cache Mode: logical
                    Hits: 1  Misses: 20  Evictions: 0  Overflows: 0  Memory Usage: 3kB
                    Buffers: shared hit=60
                    ->  Index Scan using actors_pkey on actors open_community  (cost=0.28..0.30 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=20)
                          Index Cond: (id = posts.community_id)
                          Filter: ((deleted_at IS NULL) AND (kind = 'Group'::text))
                          Buffers: shared hit=60
        ->  Seq Scan on community_removals  (cost=0.00..0.00 rows=1 width=16) (actual time=0.000..0.000 rows=0 loops=21)
Execution Time: 0.107 ms
```

`follows 130 / subscribed / hot / page 1` (EXPLAIN (ANALYZE, BUFFERS) of the key query, the statement the page runs first):

```
Limit  (cost=4860.14..4861.98 rows=21 width=52) (actual time=5.024..5.031 rows=21 loops=1)
  Buffers: shared hit=3795
  InitPlan 3
    ->  Seq Scan on age_declarations  (cost=0.00..1.04 rows=1 width=0) (actual time=0.005..0.005 rows=1 loops=1)
          Filter: (actor_id = '01a1be3c-ae6a-70fc-a984-d917df5154b9'::uuid)
          Buffers: shared hit=1
  ->  Result  (cost=4859.10..4862.60 rows=40 width=52) (actual time=5.023..5.029 rows=21 loops=1)
        Buffers: shared hit=3795
        ->  Sort  (cost=4859.10..4859.20 rows=40 width=52) (actual time=5.022..5.026 rows=21 loops=1)
              Sort Key: (hot rank) DESC, posts.published_at DESC NULLS LAST, posts.id DESC
              Sort Method: top-N heapsort  Memory: 28kB
              Buffers: shared hit=3795
              ->  Nested Loop Anti Join  (cost=6.04..4858.04 rows=40 width=52) (actual time=0.038..4.812 rows=3286 loops=1)
                    Join Filter: (community_removals.community_id = posts.community_id)
                    Buffers: shared hit=3795
                    ->  Nested Loop  (cost=6.04..4855.84 rows=40 width=48) (actual time=0.033..2.922 rows=3286 loops=1)
                          Buffers: shared hit=3795
                          ->  Hash Join  (cost=5.62..73.82 rows=17 width=32) (actual time=0.020..0.204 rows=130 loops=1)
                                Hash Cond: (open_community.id = follows.followee_id)
                                Buffers: shared hit=40
                                ->  Seq Scan on actors open_community  (cost=0.00..67.41 rows=300 width=16) (actual time=0.003..0.153 rows=300 loops=1)
                                      Filter: ((deleted_at IS NULL) AND (kind = 'Group'::text))
                                      Rows Removed by Filter: 2053
                                      Buffers: shared hit=38
                                ->  Hash  (cost=4.00..4.00 rows=130 width=16) (actual time=0.015..0.016 rows=130 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 15kB
                                      Buffers: shared hit=2
                                      ->  Seq Scan on follows  (cost=0.00..4.00 rows=130 width=16) (actual time=0.001..0.009 rows=130 loops=1)
                                            Filter: ((follower_id = '01a1be3c-ae6a-70fc-a984-d917df5154b9'::uuid) AND (state = 'accepted'::text))
                                            Rows Removed by Filter: 3
                                            Buffers: shared hit=2
                          ->  Index Scan using posts_community_published on posts  (cost=0.42..281.11 rows=19 width=48) (actual time=0.002..0.020 rows=25 loops=130)
                                Index Cond: ((community_id = open_community.id) AND (published_at <= <asOf>) AND (published_at > <asOf>))
                                Filter: ((deleted_at IS NULL) AND (removed_at IS NULL) AND (((NOT sensitive) AND (NOT nsfl) AND (NOT (ANY (community_id = (hashed SubPlan 2).col1)))) OR (InitPlan 3).col1))
                                Rows Removed by Filter: 1
                                Buffers: shared hit=3755
                                SubPlan 2
                                  ->  Index Only Scan using actors_gated on actors gated_community  (cost=0.12..8.14 rows=1 width=16) (actual time=0.004..0.004 rows=0 loops=1)
                                        Heap Fetches: 0
                                        Buffers: shared hit=1
                    ->  Seq Scan on community_removals  (cost=0.00..0.00 rows=1 width=16) (actual time=0.000..0.000 rows=0 loops=3286)
Execution Time: 5.051 ms
```

## 4. Decisions and deviations

1. **(Deviation) A card's excerpt is B1's, not the web wrapper's.** The brief says to take excerpts from `render(...).excerpt`; B1's `postViews` already returns `PostView.excerpt` as plain text from a bounded slice of the body (its note, decision 11), so the card prints text and no stored HTML reaches a feed. The web renderer is used for what a feed does need from it: every thumbnail goes through `createMarkdownRenderer().image()` in the loader (own-origin URL passes, a remote one becomes a signed proxy URL, anything else is null), as the coordinator asked. An image post with no preview shows its own image the same way.
2. **Hot follows Lemmy past the week.** The ranked set is the posts of the last 7 days before `asOf`, by `log10(max(1, score + 3)) / (hours + 2) ^ 1.8`, then date, then id. Posts older than the window have a rank of zero in Lemmy, so they follow newest first; I kept that (a second query, run only when the first runs short) instead of ending the feed at the seventh day, which would leave a quiet instance's Hot feed empty while New still has posts. The cursor says which phase it is in (`rank` is null in the second). No rank table, no refresh job, as briefed. A post scoring -2 or less ranks zero but still sorts ahead of everything older.
3. **Popular is All with a score of at least 2, and every sort works on it.** Hot is its default. A moderator or reader who picks New on Popular gets the newest posts with at least two net votes.
4. **`asOf` fixes the page set for every sort, not only Hot.** The first page takes `Date.now()`; every page after it carries it. A query keeps `published_at <= asOf` (a post published later, or dated in the future by a skewed peer, joins when a fresh first page is loaded), the Top window is `asOf - period`, and Hot ranks against it. So a page boundary cannot repeat or skip a post while the data is unchanged, and a new post never shifts the pages already read. A vote between pages can still move a post ahead of the cursor, which is expected.
5. **The cursor is unsigned.** Editing it only moves the position it names; every field is validated (ArkType), the date is exact microseconds, and one that does not match the request's sort and period, or does not parse, is treated as no cursor. Nothing reads a cursor as authority.
6. **Order ties go by id.** New, Old, Top and Hot end on `id` (uuidv7, so roughly newest first). Top is `(score, id)` as the brief says; Hot is `(rank, published_at, id)`.
7. **(Deviation from the mock) The Top period is a row of links, not a select.** A native select needs JavaScript to apply (or a visible Apply button), loses a change made before hydration, and navigating on change is a context change on input (WCAG 3.2.2). Links work before hydration and with scripts off, and the eight labels fit in a wrapping row. The sort is links too, in a `role="group"`, with `aria-current="true"`. Old is offered beside Hot, New and Top (D04 names New and Old; the mock showed three).
8. **Defaults stay out of the URL.** `validateSearch` returns only what is valid, with every other key named as `undefined`: TanStack lays the validated search over the raw address, so a key that is dropped has to come back as `undefined` to go, and a result that differs from the address makes the router redirect. `/` never becomes `/?sort=hot&period=day` (lane A's sign-in waits for `/`).
9. **Pinned posts are not floated.** `featured_local` has no mutation behind it, and a community's pin belongs on the community page. The card still shows the pinned tag if a post has it.
10. **Moderating is the fresh `community_moderators` rows** (`freshModerator` from `authz/roles.ts`, so a remote mirror row counts only once verified and unexpired). A site admin without a row has an empty Moderating feed; they act through the posts themselves. A signed-out visitor to `/moderating` gets a notice with a sign-in link (200), not a redirect.
11. **The community filter stays in the SQL.** The coordinator's note says B1's `postViews` now drops posts of a deleted or removed community and asked for the closure state to be excluded in the feed queries: that is what `visible()` does (`actors.deleted_at` and `community_removals`, same as B1 reads). It also keeps pages and keyset cursors full. Nothing filters after `postViews`, and nothing in this lane matches views to rows by position (the thumbnail and clock are per item).
12. **The sidebar lists follows including the pending ones,** as FED-A's `followedCommunities` was written for; the Subscribed feed shows only accepted ones. I did not call `followedCommunities`: it has no host for a remote handle and does not leave out removed communities, so `feeds/shell.ts` has its own query (one join, at most 500 by name). A signed-out viewer gets `listLocalCommunities({ limit })` with the default (`includeSensitive: false`, which after the F fix hides NSFL communities too). No `readCommunity` call exists in this lane, so the new third argument does not apply here.
13. **`loadShellData(session?)`** reads the cookie itself when the root loader does not pass the session, with `currentSession` and without touching the response (so the loader's own cookie refresh is not repeated). It is one extra session read per document today; request 5.5 removes it.
14. **`thumbnailSrc` is passed, and the raw URL never is.** UI's `PostCard` has no `thumbnailSrc` prop in this tree (it reads `post.thumbnailUrl`). The loader resolves the thumbnail once and returns it twice: as `FeedItem.thumbnailSrc` and in place of `post.thumbnailUrl`, so the current card is safe. `FeedPage` passes `{...{ thumbnailSrc }}`, which compiles against both. When the UI fix lands the second copy can go (section 5.6).
15. **Card ages use the loader's clock.** `FeedData.now` (ISO) is passed to `PostCard`'s `now`, so the server text and the first client render agree; no client-side `Intl` runs during hydration that the server did not.
16. **A little room under each title, for axe.** A one-line title is a 20 px link; with the meta line close below it, `target-size` (WCAG 2.2 AA) fails (it failed on `/` in the first e2e run). `feed.css` gives `.pb-post__title` a 5 px bottom margin inside the feed. It is UI's component, so the proper fix is theirs (5.7).
17. **Performance test is opt-in** (`PEBLISH_FEED_PERF=1`): it seeds 100,000 rows and its pass or fail is a timing, which a shared CI machine would make flaky. It creates the two requested indexes in the test database if the migrations lack them, and fails on `Seq Scan on posts` in a key query's plan.
18. **The e2e seed clears its own past.** `seed-c1.ts e2e` marks earlier runs' feed posts removed (by title pattern) so the best-scored and newest posts of this run lead every feed of a lane database that keeps its history.
19. **`pkill -f` happened once, and the scratchpad is shared.** Early on I ran `pkill -f` on `packages/web/.output/server/index.mjs`, which matches every lane's built server; if another lane's e2e server stopped around then, that was me (the coordinator says another lane's rebuild script did the same later). Nothing was written. My server now starts from the output folder with a relative path and is stopped by port. Lanes also share one scratchpad directory, and another lane overwrote a `check.log` of mine with its own; my later logs live in a `c1/` folder.
20. **No link to the composer.** The composer's "Create post" entry accepts `/submit?community=<id or handle>` (the coordinator's note); no feed page offers a create link of its own, since the shell's top bar already has one.

## 5. Requests to root

1. **One index on `posts`, required for the target** (`packages/core/src/db/tables/content.ts`, beside `posts_published`). Without it Top over a month, a year or all time sorts every post in the window: 39 ms (month), 159 to 187 ms (year, all time) for the signed-out All feed, and 550 ms for Popular's tenth page, first measured on this tree (p50, 20 runs). With it the same statements walk the index in order and stop after 21 qualifying rows: 2.5 to 3 ms. The expression is the score (`upvotes - downvotes`), the order is the one the queries use (`desc nulls last`, then `id`), and the query's `ORDER BY` repeats it, because Postgres only walks an index for the same null ordering.

   ```ts
   // in the posts table's index list (content.ts); needs `sql` from drizzle-orm, already imported there
   index('posts_score').on(sql`(${t.upvotes} - ${t.downvotes}) desc nulls last`, sql`${t.id} desc nulls last`),
   ```

   SQL it must produce: `CREATE INDEX "posts_score" ON "posts" (((upvotes - downvotes)) DESC NULLS LAST, "id" DESC NULLS LAST)`. The plans that use it are in section 3 (every `top:` column from a week up, and page ten of every shorter window).

2. **One partial index on `actors`, recommended** (`packages/core/src/db/tables/actors.ts`). B1's NSFW predicate tests `exists (select 1 from actors where id = posts.community_id and (sensitive or nsfl))`, which Postgres runs once per query as a hashed sub-plan: a sequential scan of `actors`, 38 pages with 2,354 actors and 0.1 ms, but it grows with every remote person the instance has ever stored (52,354 actors: 3 to 5 ms on every feed query, measured). A partial index makes it an index-only scan of the few gated communities (0.004 ms).

   ```ts
   index('actors_gated').on(t.id).where(sql`${t.sensitive} or ${t.nsfl}`),
   ```

3. **`jit = off` for the read pool** (`packages/core/src/db/pools.ts`, `connection: { jit: false }` or the `options` startup parameter). Postgres decides on JIT from the plan's estimated cost (default above 100,000), and an estimate for a feed can be far above the real cost: before the date index could be used, one plan was costed at 839,394 and spent 166 ms of 301 ms on JIT. After the fixes the heaviest estimated total I saw was 98,476 (Top by month for All, before the index in 1), one step from the threshold. Feeds are short statements on a hot table; compiling them never pays.
4. **`e2e/payload/routes.ts`: add `{ path: '/all' }`** after `{ path: '/' }` (UI's note 5.5 asked for `/` and `/all`; `/` is there). Measured with it added, then reverted: `/` and `/all` are both React and Mux JS 62.8 kB of 170, Mux CSS 60.4 kB of 65, fonts 105.6 kB of 270. The feed route adds 3.3 kB of its own script (1.3 kB gzip) and 0.9 kB of CSS outside the budget; `/all`'s document is 68.8 kB (6.8 kB gzip) for twenty cards, `/` signed out 21.2 kB (4.3 kB gzip).
5. **`packages/web/src/shell/root-data.ts`: pass the session on.** `shell: await loadShellData(session?.view ?? null)`. `loadShellData(session?)` accepts it already; today it re-reads the cookie, one more session lookup per document.
6. **UI's fix branch, `thumbnailSrc`:** when `PostCard` takes `thumbnailSrc`, delete the `thumbnailUrl: thumbnailSrc` copy in `routes/index/-feed/load.ts` (one line, marked) and the `{...{ thumbnailSrc }}` spread in `feed-page.tsx` becomes `thumbnailSrc={thumbnailSrc}`.
7. **UI, `post-card.css`:** the title link of a one-line title is 20 px high, which axe's `target-size` rejects when another link is within 12 px of its centre. A `min-height` or padding on `.pb-post__title a` (or a gap under the title) in the component fixes it for every page; `feed.css` carries a 5 px bottom margin until then. Delete it when the component has its own.
8. **README ownership table:** the C1 row gets `packages/core/src/feeds/**`, `packages/web/src/routes/{all,local,popular,moderating}/**`, `packages/web/src/routes/index.tsx` and `routes/index/**` (the shared feed page, loader and search parsing under `-feed/`), `packages/web/src/shell/data.ts`, `packages/core/src/testing/seed-c1.ts` (also a CLI: `node packages/core/src/testing/seed-c1.ts e2e` or `bulk`), `packages/web/src/i18n/feeds.json`, `e2e/feeds/**`; UI's row loses `routes/index.tsx` and `shell/data.ts` (decisions say C1 owns them now).
9. **Optional, scaling:** Hot reads the last week of posts each time (7,800 rows here). At ten times this volume it is about ten times the time (the signed-out All feed is the heaviest: 12 to 18 ms quiet on this machine with 52,354 actors). If the lab or the first weeks show that, the plan's own answer applies: a `hot_rank` column kept by a job (root's table) and an index on it.

## 6. Requests to other lanes, through root

- **UI:** 5.6 and 5.7 above (`thumbnailSrc`, the title's target size).
- **B1:** none. The feed relies on `postViews` withholding per post and on the `nsfw-gate` predicate as they are; the predicate is untouched.
- **DISC, F and later lanes that change the sidebar:** a follow, an unfollow or a moderator change must call `router.invalidate()` for the sidebar's lists to follow (the root route has `staleTime: Infinity`).

## 7. Dependencies added

None.

## 8. For later lanes

**Reading a feed.** `readFeed({ feed, sort, period?, cursor?, limit? }, viewer, q?)` from `@peblish/core/feeds/read` returns `Page<PostView>` (`{ items, next }`). `feed` is `'subscribed' | 'local' | 'all' | 'popular' | 'moderating'`; Subscribed and Moderating without a viewer are empty. `sort` is `'hot' | 'new' | 'old' | 'top'`, `period` (Top only) one of `'1h' | '6h' | '12h' | 'day' | 'week' | 'month' | 'year' | 'all'`; names, defaults and the page size (20, at most 50) are in `@peblish/core/feeds/input`, which the browser may import. `next` is the cursor for the following page; pass it back as `cursor` with the same sort and period. The viewer is `{ actorId, siteRole }` or null, as for `postViews`.

**A community page or a profile (DISC, F, E1)** can reuse the keyset machinery, not the feed names: copy the shape of `byDate` and `byScore` in `read.ts` with `posts.community_id = <id>` (or `author_id`) in place of the feed's membership clause, keep `visible()`'s other conditions (so every registered predicate applies), and the same `Cursor`. `posts_community_published` and `posts_author_published` serve the date sorts and `posts_score` (5.1) the score sorts. I did not generalise `FeedName` for that; it is a small addition to `read.ts` if the lane wants it.

**A new `feedPredicate` (E1 blocks, MODF instance blocks)** needs nothing from this lane: `<area>/feed-predicate.ts` is read by glob and applied to every feed. Write it as SQL over `posts` with a correlated sub-select on an indexed key, as `nsfw-gate` does; the key queries run it once per scanned row (Hot scans about 7,800), so a predicate that does a seq scan per row will show in `perf.test.ts` before it shows in production. `viewer` is `{ actorId }` or null.

**The page.** `routes/index/-feed/` holds the shared parts: `search.ts` (`parseFeedSearch`, `resolveFeedSearch`, `feedHref`), `load.ts` (`loadFeed`, a server function: session, `readFeed`, thumbnails through the renderer), `feed-page.tsx`, `route.ts` (`feedRoute(feed, title)`, the options each route file spreads), `feed.css`. A route that shows a feed (a community page) can spread `feedRoute` and render `FeedPage` once it has its own `feed` in `loadFeed`.

**Seeds.** `seedFeedWorld()` (a small cast with follows, a moderator and every community state), `seedFollow`, `seedFeedPost(instance, community, author, { ago, up, down, ...columns })`, `seedBulk({ local })` (100,000 posts). `node packages/core/src/testing/seed-c1.ts bulk` fills a database with the bulk world: run it on a database of its own, as `peblish_c1_perf` was, since e2e specs read the lane database.

## 9. Left open and risks

- Hot's cost grows with a week of posts (section 5.9). It is the one query shape that scans a window rather than walking an index.
- Pinned (`featured_local`) posts are not floated; no mutation sets the flag.
- The sort and the period are not remembered; a signed-in default sort is a settings feature for later.
- The Top period row wraps to a second line beside the density switch below about 1,000 px; it is the same toolbar as the mock with one more control.
- There is no "mark as read", no unread count (E2) and no per-feed language filter (a keyword or language predicate arrives through the registry).
- Timings are taken on a shared machine: the load average was 19 to 40 on 18 cores during the last runs, which is why the opt-in test is not part of `pnpm check`.
