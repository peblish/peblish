# Lane FED-A: outbound federation (wave 2)

Branch `mvp-w2-fed-a` from `485f084`, worktree `/Users/admin/Projects/feddit-mvp-w2-fed-a`, lane `fed-a` (port 18309, database `peblish_fed_a`). Nothing is pushed. No migration is committed: `git status` shows nothing under `packages/core/drizzle/`.

## 1. What landed

| Deliverable (brief item)                                                                                                                                                                                                                                    | State                            | Proof                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Signing: draft-cavage-12 rsa-sha256 with a SHA-256 `Digest`, one signature per request, never a second scheme                                                                                                                                             | done                             | `signing/signing.test.ts`: ours verified by ours, Fedify-signed verified by ours, ours verified by Fedify's `verifyRequestDetailed`, and the failure table                                                                                                 |
| 1 Inbound verification for FED-B                                                                                                                                                                                                                            | done                             | `signing/inbound.test.ts`: stored key, fetched key, rotated key (refetched at most once a minute), stranger, a local actor's own key refused, tampered body                                                                                                |
| 2 Remote actors: `resolveRemoteActor(apId or handle)`, WebFinger, fetch, `actorFromWire`, `storeRemoteActor`, network outside the transaction                                                                                                               | done                             | `actors/resolve.test.ts`, `core/src/remote/remote.test.ts` (16 tests, two concurrent stores make one actor)                                                                                                                                                |
| 3 Serving: local actors at their stored ap_id (`/ap/u.*`, `/ap/c.*`, imported `/u/*`, `/c/*`), the instance actor at `/`, followers, outbox, featured, moderators, Page, Note, Tombstone, activities by id, inbox POSTs to `receiveInbound`, `Vary: Accept` | done                             | `actors/serve.test.ts` (17), `http.test.ts` (32), `e2e/server/federation.spec.ts` (6)                                                                                                                                                                      |
| 4 WebFinger (`acct:` and actor URL; imported `feddit-admin` resolves to its stored `/u/feddit-admin`)                                                                                                                                                       | done                             | `webfinger/serve.test.ts`                                                                                                                                                                                                                                  |
| 5 NodeInfo 2.1 and 2.0, discovery, usage fields; client with a one day refresh                                                                                                                                                                              | done                             | `nodeinfo/serve.test.ts`, `delivery/delivery.test.ts` (client use before first delivery)                                                                                                                                                                   |
| 6 Announce shape by follower software, lists as data, never both to one inbox                                                                                                                                                                               | done                             | `delivery/software.test.ts`, `delivery/consumer.test.ts` (Lemmy, PieFed, Mastodon, unknown followers: one delivery per inbox)                                                                                                                              |
| 7 Durable delivery: one row per (activity, inbox), body fixed at enqueue, `SKIP LOCKED` claim with a 60 s lease, sign once, no redirects, response cap, permanent versus retried, capped backoff, dormant skip                                              | done                             | `delivery/delivery.test.ts` (35): dead worker's lease expires and the row is sent again, permanent status stops, redirect not followed, private address refused through the real fetcher, backoff capped, dormant skipped, two workers claim disjoint rows |
| 8 Outbound consumer `federation.delivery`: Create, Update, Delete, Undo(Delete), Like, Dislike, Undo(Like), Follow, Accept, Undo(Follow), profile Update                                                                                                    | done                             | `delivery/consumer.test.ts`; shapes against the accepted corpus in `delivery/corpus.test.ts`                                                                                                                                                               |
| 9 Follows: `requestFollow`, `acceptFollow`, `removeFollow`, `receiveFollow`, `retryFollow`, `followState`, `followedCommunities`; the first-contact retry job                                                                                               | done                             | `core/src/follows/follows.test.ts` (16): fresh id at 5 and 15 minutes on a fake clock then pending kept, Accept matches the Follow id and actor                                                                                                            |
| 10 `packages/federation/README.md`                                                                                                                                                                                                                          | done                             | the file                                                                                                                                                                                                                                                   |
| Plan row: Follow with first-contact retry and pending state; outbound Create, Update, Delete, Like, Undo, Announce shaped per follower software, proven against the corpus                                                                                  | done on shape; live proof is LAB | corpus tests compare each outbound document with the `feddit-spike-0.0.1/outbound` entries Lemmy and PieFed accepted, allowing only documented dialect differences, and the `Announce(Page)` shape against Lemmy's own                                     |
| `core/src/actor-keys.ts` addition                                                                                                                                                                                                                           | not needed                       | the worker reads `actor_keys` directly; no helper was missing                                                                                                                                                                                              |

Not done on purpose: anything that contacts a real peer; the inbox pipeline (FED-B); the dormant policy (REM).

## 2. Commits

Early-merge commits, in the order FED-B needs them, each standalone:

- `6ba4769` Add drizzle-orm to federation for the delivery queue and actor reads (dependency and lockfile only)
- `7929c82` Add draft-cavage signing for delivery and signature checks for the inbox
- `0b7ad8f` Add the remote actor store, the actor fetch on safeFetch and inbound signature checks (needs `actors/safe-fetch.ts`, so B2 first or the shim stays)

The rest, in order:

- `576ee49` Add the follows service: request, accept, remove, receive, and the first-contact retry
- `0fac761` Add the durable delivery queue: table, claim with leases, signed POSTs and the retry policy
- `eb106b0` Match the safeFetch stand-in to B2's surface: truncated bodies and the timeout error
- `4834820` Add the outbound consumer: Create, Update, Delete, Like, Undo, Follow and Accept, announced per follower software
- `d8011ab` Name peblish in the User-Agent of every request we make
- `5267920` Serve actors, collections, posts, comments and activities, WebFinger and NodeInfo
- `d639c50` Test the served instance actor, WebFinger, NodeInfo and the inbox answer end to end
- `44c232e` Describe federation: what Fedify does, what we serve, the delivery policy
- the commit that adds this file

## 3. Verification

With `PEBLISH_MIGRATIONS_DIR` pointing at a scratch copy of `packages/core/drizzle` plus the one new migration (below), on port 18309:

- `pnpm check` (build, typecheck, boundaries lint, oxlint, prettier, tests): exit 0, 76 test files and 1,265 tests passed (1 file and 2 tests skipped as before).
- `pnpm e2e`: 36 passed, including the six federation specs.
- `scripts/image-smoke.sh` against an image built from this tree, on a fresh database migrated with the scratch folder: ok (the worker starts with the new consumer and the two new jobs, web uid 1000). The smoke database and image were removed afterwards.
- Without the `deliveries` table in the migrations, the delivery tests fail (46 of them did before I exported the folder); root's generated migration fixes that.

## 4. Decisions and deviations

1. **Fedify only signs.** The brief kept Fedify's memory key-value store; nothing here runs on a `Federation` object (compaction, one actor path, a queue that loses a crashed message, a retry that hides the first error), so `federation.ts` is now only the software identity (`software`), `localOrigin()` and `userAgent()`, and the unused `createPeblishFederation` skeleton is gone. Fedify's `signRequest` is the one thing used (`signing/sign.ts`). Root to confirm. `@fedify/vocab` is not used.
2. **B2 seam, and a discrepancy.** `decisions.md` line 55 says FED-A merges B2's `e992063` and `07813d8`; the coordinator's later message says do not merge, root merges B2 first. I followed the message. The stand-in `actors/safe-fetch.ts` has B2's names and shapes (`SafeFetchInit`, `SafeResponse` with `truncated`, `BlockedDestinationError`, `FetchTimeoutError`, `safeFetch`), checked against `packages/core/src/net/fetch.ts` on `mvp-w2-b2`.
3. **Announce shapes.** Unknown or unread software gets FEP-1b12 (`Announce(Create(Page))`). Mastodon-like software, a list of NodeInfo names in `delivery/software.ts`, gets `Announce(Page)` for a new post only. An inbox shared by followers of both kinds gets the FEP-1b12 shape. Everything else in a community (Update, Delete, comments, votes) is announced as FEP-1b12 to every inbox.
4. **Retry policy** (`delivery/policy.ts`): 10 attempts; waits of 10 s, 30 s, 90 s, 270 s, 810 s, 2,430 s, 7,290 s, then 6 h twice: 54,130 s, about 15 hours, from the first failure to the last attempt. Retried: 401, 408, 425, 429, 5xx, timeouts and connection errors. Permanent: every other 4xx, every 3xx, `BlockedDestinationError`. `Retry-After` can lengthen a wait up to 6 hours. PieFed's day-one cap on a new remote account's fifth post is permanent by the 4xx rule; the status PieFed answers is unmeasured (LAB).
5. **First-contact Follow retry.** Offsets are measured from the first Follow, not from each other: a fresh Follow id at 5 minutes and at 15 minutes, then pending for good. The job `follows.retry` runs every 30 seconds as the system principal `scheduled`; the mutation repeats the due check under the row lock.
6. **Followers collection** is `Collection` with `totalItems` (accepted followers) and `items: []`, listing nobody. Lemmy reads only the count, and its own parser requires `items`.
7. **Outbox** of a community is its stored Create activities for live local posts (20 newest, as Lemmy's is Create(Page)). People and the instance actor have empty outboxes. **Featured** lists pinned local posts as Page objects (remote pinned posts are left out). **Moderators** lists owners first and leaves out deleted accounts.
8. **WebFinger** matches `lower(name)` across Persons, Groups and the instance actor (names are unique across kinds, so no `!name` versus `@name` collision exists here). A deleted account answers 404; its actor document is still 200. Links are Lemmy's: a profile page and `self` with `properties["https://www.w3.org/ns/activitystreams#type"]`; `rel` narrows, CORS is open.
9. **Status codes.** Deleted or removed posts and comments are `410` with a Tombstone (object paths are not in the never-410 list); a deleted local actor is `200`. An unexpected failure on any federation path, a database outage for one, is `503` with `Retry-After: 60`, never a 500. A page path (`/`, `/u/*`, `/c/*`) nobody here owns is declined (`null`), so the UI renders its own page; a non-GET to those paths is also declined. `GET` of an inbox and a write to a document are 405.
10. **Origin from the database.** `localOrigin()` reads the local instance row, not the request URL, so a reverse proxy or the e2e `127.0.0.1` host cannot change which ap_ids are looked up.
11. **NodeInfo usage.** `users.total` is local Persons with an account; active means a session used, a post or a comment written in the last 30 days (month) or 182 days (half year). Counts are cached for 60 seconds on `globalThis`. `openRegistrations` is false. `metadata.nodeName` is the instance actor's display name, else its name, which is what the actor document says too.
12. **Remote actor store.** `storeRemoteActor` and `deleteRemoteActor` run only for the system principal `import`. An unknown ap_id on our own origin is `not_found`; we never fetch ourselves. A peer that is down returns the stored copy.
13. **User-Agent** on every outbound request: `peblish/<version> (+<origin>)`.
14. **The one edit outside the write set:** `e2e/server/federation.spec.ts`. Its first test expected the HTML shell for an ActivityPub request to `/`, which was the placeholder until federation answered. The brief's verification names the federation specs under `e2e/server/`, so I rewrote the file (six tests) and flag it here for root.

## 5. Requests to root

1. **Generate the migration** for the `deliveries` table in `packages/core/src/delivery/tables.ts` (unique `(activity_ap_id, inbox_url)`, a partial index `deliveries_due` on `next_attempt_at` where `state = 'pending'`, `deliveries_object`, `deliveries_instance`, state check, foreign keys to `actors` and `instances`). It is the only table this lane adds; no existing table changed. My scratch output, to compare with, is `/private/tmp/claude-501/-Users-admin-Projects-feddit/68fae2dc-24c3-4150-a10a-6de89e6e702a/scratchpad/mig/drizzle/0004_wave_2_fed_a.sql` (the committed folder has `0001` to `0003`, so it is `0004` now). Tests need it: `PEBLISH_MIGRATIONS_DIR=<folder>` or the committed file.
2. **Merge B2 before this branch, then switch the seam.** Replace the body of `packages/federation/src/actors/safe-fetch.ts` with
   `export { BlockedDestinationError, FetchTimeoutError, safeFetch } from '@peblish/core/net/fetch'; export type { SafeFetchInit, SafeResponse } from '@peblish/core/net/fetch';`
   and delete `packages/federation/src/actors/safe-fetch.test.ts`. Files that import the stand-in: `actors/document.ts`, `actors/resolve.ts`, `delivery/run.ts`, and the tests `actors/resolve.test.ts` and `delivery/delivery.test.ts` (for `BlockedDestinationError`). `nodeinfo/client.ts` and `signing/inbound.ts` take the `Fetcher` type from `actors/document.ts` and need no change.
3. **README ownership table, FED-A row** (`README.md` line 81): the lane now owns `packages/federation/src/{actors,webfinger,nodeinfo,signing,delivery}/**`, `federation.ts`, `http.ts`, `packages/federation/README.md`, `packages/core/src/{follows,remote}/**` (REM inherits `remote/`), `packages/core/src/delivery/tables.ts`, `authz/actions/{follows,remote}.ts`, `packages/schema/src/{refusals/follows,events/follows,events/remote}.ts`, `testing/seed-fed-a.ts` and `packages/web/src/server/federation.ts`. The paragraph at line 56 still says FED-A owns only `http.ts` and the consumers.
4. **Dependency:** `drizzle-orm` 0.45.4 was added to `packages/federation/package.json` and the lockfile (`6ba4769`).
5. **Author self-vote** (decisions.md): the consumer sends a Like for any local `vote.cast`, so the self-vote added at integration is announced like any other vote; nothing to change here.
6. The generated registries (`consumers.gen.ts`, `jobs.gen.ts`) are produced by `pnpm gen`; my consumer `federation.delivery` and the jobs `federation.delivery_queue` and `follows.retry` appear there after it.

## 6. Requests to other lanes

- **FED-B:** replace the body of `receiveInbound` (`inbound/receive.ts`); `http.ts` already sends every inbox POST (`/inbox`, `/ap/u.*/inbox`, `/ap/c.*/inbox`, `/u/*/inbox`, `/c/*/inbox`) to it. Use `verifyInboundSignature(request, body)`; it refetches an unknown key's actor at most once a minute but does not throttle callers, so throttle the unknown-key fetches yourself. Call `acceptFollow` (Accept: matches the Follow id, the local follower and the accepting community), `removeFollow` (Undo, or Reject by actor) and `receiveFollow` (a remote Follow of a local community, accepted at once; the consumer sends the Accept). Store authors and key owners with `resolveRemoteActor` / `storeRemoteActor`. Use `enqueueDeliveries` and `followerInboxes(db, actorId, { skipOrigin })` for the relay; the Announce shape is chosen per inbox there. The moderators mirror and its table are yours.
- **REM:** `isDormant(instanceId)` in `core/src/remote/instances.ts` returns false; the delivery worker already skips instances it reports and marks the rows `skipped`. `deliveries` rows are never pruned: add a job for settled rows (and an index on `settled_at` if you scan by it). `instance_health` can read `deliveries(instance_id, state)`, indexed. You inherit `remote/{actors,instances}.ts`.
- **C1:** `followedCommunities(actorId)` and `followState(actorId, communityId)` in `core/src/follows/read.ts`.
- **LAB:** see 8.

## 7. Dependencies added

- `drizzle-orm` 0.45.4 in `@peblish/federation`.
- `@fedify/fedify` 2.4.5 was already there; only `signRequest` is used.

## 8. For later lanes

**Running peblish as a lab peer.**

- Three things run: `migrate` with `PUBLIC_ORIGIN=https://peblish.lab.test`, `web` (serves every document above) and `worker` (`PEBLISH_PROCESS=worker`: the outbox consumers, `federation.delivery_queue` every 2 s, `follows.retry` every 30 s). Federation needs no other configuration.
- The lab's hosts resolve to private addresses, and `safeFetch` refuses them with no switch. B2 documents the way out: the lab builds its own client with `createSafeFetch({ resolve, isPublic })`. The single seam is `actors/safe-fetch.ts` (after root's swap, a re-export): the lab image can overlay that one file with a lab client, outside product code. The lab CA also has to be trusted by Node (`NODE_EXTRA_CA_CERTS`).
- Caddy needs a `peblish.lab.test` host that passes the original Host and, for WebFinger and NodeInfo, no caching beyond the headers we send.
- No community-creation mutation exists yet. Seed a local Group like the tests do (`core/src/testing/seed.ts`, `seed-fed-a.ts`): an `actors` row with `inbox_url`, `outbox_url`, `followers_url`, `shared_inbox_url` set, an `actor_keys` row from `newRsaKeyPair()` (`core/src/actor-keys.ts`), and a person with an account for the mutations.
- To follow a lab community: `resolveRemoteActor('!lab@lemmy.lab.test')` stores it, then `requestFollow` (see `follows.test.ts` for the authorize-then-mutate call). The Follow goes out through the worker; the Accept comes in through FED-B's inbox, not before.
- To watch it: `select state, attempts, last_status, last_error, inbox_url from deliveries order by created_at`.
- Expected Lemmy behavior to check live: the first Follow to a new Lemmy instance may be lost and the 5 and 15 minute resends exist for that; Lemmy rejects `Announce(Page)`; PieFed's response to a fifth post in a day (permanent here).

**Other notes.**

- Every document is served from `toWire`, so a mapping change in FIT's files changes what peers fetch and receive together.
- Add a new activity by writing its builder in `delivery/activities.ts`, calling `publishInCommunity` (or `sendActivity` for a single inbox) from the consumer, and adding its accepted shape to `delivery/corpus.test.ts`.
- Anything that is not public (a private message, an unlisted flag) must be filtered out of `actors/serve.ts` before it exists: it serves any local activity, post and comment by id.

## 9. Left open and risks

- **A poison event stalls the consumer.** If `federation.delivery` throws for an event on every try, the outbox worker retries it with backoff (up to 5 minutes) and the consumer's later events wait. Database errors should retry; I found no deterministic throw in the handlers, and did not add a skip.
- **Imported communities have empty outboxes.** The outbox lists stored Create activities; imported posts have none. A remote instance that subscribes after cutover and backfills from the outbox sees nothing until posts are made. Synthesizing Creates from posts is a small addition if LAB shows it matters.
- **Mentions** go only to inboxes the activity would reach anyway: a mentioned remote person who does not follow gets nothing.
- **Profile and community edits.** A community's `Update(Group)` goes to its remote followers' inboxes, a person's `Update(Person)` to the inbox of every peer we trade follows with (`peerInboxes`), as Lemmy does; whether Lemmy and PieFed apply either from a new peer is untested live.
- **No pruning** of `deliveries` (REM) and no limit on how many rows one burst queues.
- **At-least-once.** A worker killed after a peer accepted but before the row is marked sends the activity twice; receivers dedupe on its id.
- **PieFed's day-one cap status** and **Lemmy's reaction to an unknown software** are measured live, in wave 3.
- **The stand-in fetcher** is the spike's reviewed guard behind B2's contract, with its own test; B2's module replaces it, and nothing else depends on its internals.
