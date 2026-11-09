# Lane PERF notes (wave 3, feed perf regression)

Branch `mvp-w3-perf` from `w3-review` (96d94dd). Lane database `peblish_b06` (port 18323).

## 1. What landed

The Subscribed feed no longer reads every followed post and sorts them. With E1's block predicate and MODF's blocked-peer predicate in the query, a Subscribed page took 35 to 110 ms. It is now an index walk of under 1 ms, for all three viewers. Proof: `PEBLISH_FEED_PERF=1 pnpm exec vitest run --project core packages/core/src/feeds/perf.test.ts`, with the EXPLAIN check (no `Seq Scan on posts`) on every row.

There were two causes, and both had to go:

1. **The follows estimate.** `exists (select 1 from follows where follower_id = $viewer and followee_id = posts.community_id)` was estimated at 17 followed communities, where the viewer had 130. Reading 17 communities' posts and sorting them looked cheap. The plan was already on a knife's edge in wave 2, and any extra filter tipped it.
2. **The predicates' estimates.** Postgres estimates that each `x not in (select ...)` keeps half the rows (a fixed 0.5 for a SubPlan). The predicates had four such clauses, plus correlated per-row actor lookups that are costed on every walked row even when they never run. Together they made the index walk look about 16 times dearer.

The fix:

- `feeds/read.ts`: `followedCommunities(q, viewer)` reads the accepted follows first. Subscribed then filters with `posts.community_id = any($1::uuid[])`, so the planner sees the real count: it walks `posts_published` or `posts_score` for 130 follows and reads each community for 3. A viewer with no accepted follows gets an empty page without the key query. `visible()` takes the array as an optional fifth argument (Subscribed throws without it; profiles call `visible('all', ...)` unchanged).
- `blocks/feed-predicate.ts`: three `<> all(array(select ...))` tests: blocked people; blocked communities plus Groups on blocked instances; and the author's instance (looked up per post only when the viewer has an instance block, as before). Postgres estimates each as keeping nearly every row.
- `peers/feed-predicate.ts`: the same form for the post's instance and the Groups on blocked peers.
- `feeds/perf.test.ts`: E1's blocker now follows the same 130 communities and has a Subscribed case. A second pass adds 25 blocked peers (22 empty instances and 3 of the 40 that hold posts, about 7% of posts) and reruns signed out All and Popular, the 130-follow viewer's Subscribed and All, and the blocker's All and Subscribed. `analyze` now runs after the blocks and follows are seeded.

What every viewer sees is unchanged: the block, peer, feed, profile and posts tests pass unedited.

## 2. Commits

- `ba74ce7` Keep the Subscribed feed on its index walk with blocks and blocked peers
- this notes commit

## 3. Verification

- `pnpm check` green on `ba74ce7`: 218 files passed, 4 skipped; 2,508 tests passed, 7 skipped. No load timeouts this time.
- Focused tests (feeds, blocks, peers, profiles, `posts/read.test.ts`): 121 passed, 2 skipped (the opt-in perf files).
- `PEBLISH_FEED_PERF=1 profiles/perf.test.ts`: passed twice, at load 17 and 22; worst p95 20.4 ms.
- `PEBLISH_FEED_PERF=1 feeds/perf.test.ts`, worst p95 per viewer. Load average was 14 to 22 throughout, from five reviewers and the lab. "Before" is `w3-review` running this same test file, edited only to drop the `followed` argument; the full per-row table is `before-after.md` in the scratchpad (below).

| Viewer, feed                               | Before                  | After (default plan cache)                             | After, `force_custom_plan` run 1 / run 2                   |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| No blocks, Subscribed (130 follows)        | 84.2 ms, 8 rows over 50 | 65.0 ms, 2 rows (3-follow viewer, generic plan, see 9) | 24.4 / 31.0                                                |
| No blocks, other feeds                     | 30.0                    | 36.4                                                   | 27.3 / 30.4                                                |
| E1 blocker, Subscribed                     | 109.7, 8 rows over 50   | 26.4                                                   | 20.2 / 79.9 (3 rows over 50, load spike; 8 to 17 ms alone) |
| E1 blocker, other feeds                    | 38.3                    | 33.8                                                   | 24.4 / 38.7                                                |
| 25 blocked peers, 130 follows, Subscribed  | 79.3, 7 rows over 50    | 24.3                                                   | 18.2 / 19.3                                                |
| 25 blocked peers, 130 follows, other feeds | 41.9                    | 75.8 (1 row, load spike)                               | 29.7 / 71.4 (1 row, load spike; 23 ms alone)               |
| 25 blocked peers, blocker, Subscribed      | 92.4, 8 rows over 50    | 23.3                                                   | 22.8 / 17.9                                                |
| 25 blocked peers, blocker, other feeds     | 38.7                    | 39.8                                                   | 41.1 / 25.0                                                |

The worst Subscribed rows, from the test's own EXPLAIN (ANALYZE, BUFFERS); excerpts are in `explain-before-after.txt` in the scratchpad:

- **130 follows, Subscribed New, page 1.** Before: 33.5 ms. Nested loop over 130 follows into `posts_community_published` (estimated 20 rows, actual 39,437), then a top-N sort; 41,307 buffers. After: 0.15 ms. Index Scan on `posts_published`, 22 rows walked; 137 buffers.
- **130 follows, Subscribed Top all, page 1.** Before: 37.0 ms, the same 39,437-row read and sort. After: 0.17 ms, an Index Scan on `posts_score`, 21 rows.
- **Blocker, Local Top month, page 10.** Before: 23.7 ms (598 per-row author lookups and 294 community lookups). After: 1.9 ms.

In every run the "after" rows over 50 ms ran in 0.4 to 5 ms under EXPLAIN and 7 to 23 ms when rerun alone. They came from load spikes or the generic-plan hazard (9.1), not from the plans.

## 4. Decisions and deviations

1. **The follows come first, as an array parameter.** This was the cause the brief did not name. Rewriting only the predicates (`<> all`) still left the 130-follow viewer at 45 to 50 ms, because the plan still chose to read and sort 17 estimated communities. With a literal follow array the 130-follow rows dropped from 121 ms to 0.6 ms (New) and 87 ms to 0.5 ms (Top all) under EXPLAIN, and the 3-follow viewer stayed at about 2 ms. One parameter (`$n::uuid[]`), not an `in ($1, ..., $k)` list: a list would make the statement text vary with the follow count, and postgres.js keeps one prepared statement per text per connection.
2. **Predicates as `<> all(array(select ...))`, not the other options.**
   - `not exists` (the integrator's try) changes the join shape.
   - Leaving a predicate out when its set is empty does nothing for the blocker or for a site with peer blocks, and an empty array already costs nothing.
   - Resolving the sets to id arrays in TypeScript would give hashed lookups and exact estimates. But it needs an async `FeedPredicate` (`registry/types.ts`, outside the write set), an extra round trip per predicate, and the same generic-plan caveat.
   - A fenced over-fetch breaks when long runs are blocked.
   - A denormalised column already exists in `posts.instance_id` (see 3).

   The array form is a sync SQL change in each lane's own file. Measured cost at E1's limits (500 people, 150 communities, 27 instances, all with 130 follows): the linear `<> all` probe adds up to about 13 ms to Hot, worst p95 28 ms at load 11.

3. **The author's instance is still looked up through `actors`, not `posts.instance_id`.** Using `posts.instance_id` was a little faster on Hot (17 against 25 ms for the blocker), and every write path stores the author's instance there; MODF relies on that. But E1's `predicate.test.ts` world has a local-instance post by a lemmy person, and on that data the result would differ. Exact semantics cost about 10 ms on Hot at most, so I kept them.
4. **Groups only in the "community on a blocked instance" array.** The old predicate tested the community actor's instance whatever its kind. Every feed already requires the community to be a Group (`visible()`), and an array without the kind filter would hold every person on the blocked instances. Same result in every feed and on the profile.
5. **Perf test seeding** (deviation from the old file): `analyze` now runs after the blocks and follows are inserted, as a running site's statistics would be. The blocker follows the same 130 as the busy viewer, so their Subscribed case means something. The peer pass blocks 3 instances with content plus 22 empty ones. feddit.com's banned list is mostly instances that never federated content in, so 25 content-bearing peers out of 40 would hide 62% of the posts; that would test a site that does not exist.

## 5. Requests to root

1. **`packages/core/src/db/pools.ts`: read pool, custom plans only.** Change
   `...(readOnly && { jit: 'off' }),` to
   `...(readOnly && { jit: 'off', plan_cache_mode: 'force_custom_plan' }),`
   and extend the comment above it, for example: "...and custom plans only: a cached generic plan cannot see the page's clock, the Top period or the viewer's follows, and once chosen it serves every viewer on that connection."

   Why: postgres.js prepares every statement, and after five executions Postgres may keep a generic plan for the connection. A feed's text is the same for every viewer and every Top period. Evidence:
   - With `force_generic_plan`, signed-in All Top year takes 133 ms on `w3-review` (96 ms on this branch), against 1 ms custom.
   - On this branch the generic Subscribed plan is the 130-follow viewer's, which costs the 3-follow viewer's Old row 37 ms p50, against 1.4 ms custom.
   - With the setting, both full perf runs had no generic-plan rows; their only rows over 50 ms were load spikes that ran in 8 to 23 ms alone.

   Planning these statements costs about 0.5 ms. The hazard is there on `w3-review` too, so the feed perf test stays flaky under load until this lands.

2. No schema or index change.

## 6. Requests to other lanes, through root

- E1, MODF: a new feed predicate should test small viewer or site sets with `<> all(array(select ...))`. Avoid `not in (select ...)`, and avoid correlated lookups per post where an uncorrelated array will do (see the doc comments in both files).

## 7. Dependencies added

None.

## 8. For later lanes

- `visible(feed, viewer, asOf, scope?, followed?)`: Subscribed needs `followed` from `followedCommunities(q, viewer)` and throws without it. `keyQueries` takes it as `Reading.followed`. `readFeed` does both for you.
- A predicate that adds a filter on `posts` changes the estimate of every LIMIT walk. Run the feed perf test with `FEED_PERF_PLANS=<file>` and read the Subscribed rows' plans.

## 9. Left open and risks

1. Until root's request 1 lands, any feed row can take a generic plan under the default `plan_cache_mode`. This predates this branch; the rows it hits move around between runs.
2. A viewer whose blocks hide everything they follow gets an empty Subscribed feed only after reading every followed post. That is 60 to 110 ms at 43,000 posts, both before and after, because no index can prove the page empty. This is an edge; a cap or a "you blocked all of these" notice would be product work.
3. `<> all` over an array is a linear probe per walked row. At E1's limits it adds about 13 ms to Hot; raising `maxPersonBlocks` or `maxCommunityBlocks` well past 500 would need the TypeScript pre-resolve (hashed arrays), which needs an async `FeedPredicate`.
4. The peer pass uses the busy viewer's 130 follows, of which a few sit on the 3 blocked content instances. A site whose blocked peers hold most of a viewer's follows would walk further, as in 2.
