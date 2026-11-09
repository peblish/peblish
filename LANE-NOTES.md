# Lane LAB: notes

Lane LAB, wave 3, branch `mvp-w3-lab`, plan row B02. The production Docker image now runs against Lemmy
0.19.21, PieFed 1.8.11 and Mbin 1.11 for a full round trip, with an exact-reason matcher, a cleanup ledger
and scenarios for instance-wide bans, account deletion and `Update(Group)`. `INTEROP.md` is the entry point.

## 1. What landed

| Deliverable                                                                                                                                                                                 | Where                                                                                 | Proof                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| peblish in the lab: `peblish-migrate`, `-web`, `-worker`, `-db` from the root `Dockerfile`, no lab switch; spike services removed; subnet `44.255.99.0/24` (public space, internal network) | `lab/compose.yaml`, `lab/caddy/Caddyfile`                                             | `make up` healthy; `tools/interop/src/lab-config.test.ts` (every /24 address passes `isPublicAddress`; peblish gets only the shipped variables)                                                                                                                                                                        |
| Mbin 1.11 as a third peer (FrankenPHP, messenger, RabbitMQ, Valkey, Postgres)                                                                                                               | `lab/mbin/`, `lab/compose.yaml`, `tools/interop/src/peers/mbin.ts`, `mbin-clients.ts` | F1 to V1 pass on Mbin; see INTEROP.md                                                                                                                                                                                                                                                                                  |
| `@peblish/interop`: driver (core as a local user, no control surface), peers, seeds, matcher, rogue, runner                                                                                 | `tools/interop/`                                                                      | `match.test.ts` (right reason passes, another or absent fails, zero or two rows fail, known signature exact), 23 tests in the package                                                                                                                                                                                  |
| Scenarios F1, F2, P1 to P3, C1, C2, V1, V2, N1, M1, Z1, B1, H1, S2, S3, X1, D1; F3 as the slow tier; S1 and R1 as `pending`                                                                 | `tools/interop/src/scenarios/`                                                        | `make check` from `make reset`, section 3                                                                                                                                                                                                                                                                              |
| Cleanup ledger closing the three gaps of L9                                                                                                                                                 | `tools/interop/src/ledger.ts`, `cleanup.ts`, `cleanup-main.ts`                        | `cleanup.test.ts`: (a) a retry re-checks an Undo whose local follow row is gone, and an undelivered Undo stays open; (b) a peer vote peblish never recorded is found from `my_vote` and cleared; (c) an object without a peer id is resolved by `ap_id`, and failing to resolve is a failure that keeps the entry open |
| D1 around a SIGKILL of the worker                                                                                                                                                           | `scenarios/durability.ts`, `make interop-d1`                                          | three runs in a row green                                                                                                                                                                                                                                                                                              |
| `INTEROP.md`, new `lab/README.md`                                                                                                                                                           | repository root, `lab/`                                                               | read it                                                                                                                                                                                                                                                                                                                |

## 2. Commits

```text
6d5a997 Run peblish itself in the lab on a public-space subnet
71c4698 Add the @peblish/interop workspace package
f2e0819 Add the @peblish/interop importer to the lockfile        (the lockfile change, alone)
62f8463 Add the interop runner: peers, driver, seeds, matcher, ledger, rogue
ebb4e8b Add Mbin 1.11 to the lab
89d78ef Add the follow, post, comment, vote and Mastodon-follower scenarios
e81bb05 Add moderation, authorization matrix, missing-object and protocol scenarios
8331339 Add Update(Group), account deletion, new-author and pending moderation scenarios
965d61d Add the cleanup ledger, the D1 delivery schedule and the F3 slow tier
9bc4f2f Make a clean make check start: limit Mbin's threads, age PieFed users in the runner
4352726 Clear Mbin's cache per group, follow the held activity in D1, pin X1 as a range
1bb68ea Document the interop lab: INTEROP.md and a new lab README
```

This file is the last commit.

## 3. Verification

- `make check` from `make reset` (reset, up, seed, `interop`, `interop-d1`, cleanup): 998 s, 16.6 minutes,
  against a budget of about 20. Fast tier 66 pass, 0 fail, 9 known, 6 n/a, 7 pending. D1 8 pass. Cleanup 61
  cleaned, 0 failed. Two earlier clean runs found real problems that are fixed (Mbin's FrankenPHP hanging
  under Rosetta with one Go thread per core; PieFed's day-one cap and Mbin's post rate limit hitting
  late groups); the last run is the one reported.
- Z1 (16 cases) and D1 (8 cases) each passed three runs in a row on the final tree. F3 (17 minutes) passed.
- `pnpm check` on the final tree (build, typecheck, lint, boundaries and prettier pass): 2,103 tests pass and 9
  fail. Seven are in `packages/core/src/remote/backfill.test.ts` and `packages/federation/src/backfill/backfill.test.ts`,
  which hard-code `new Date('2026-11-09T12:00:00Z')`; the wall clock passed that at 12:00 UTC today, so they fail
  on any machine from then on (request 1). The other two (`moderators-cache.test.ts`, `outbox/worker.test.ts`;
  earlier runs `migrate.test.ts`) are timeouts on a machine whose load average was 12 to 40 with other lanes running;
  each passes when run alone. The 23 tests of `tools/interop` pass. `pnpm e2e` was not run: nothing outside the lab
  changed.
- Every `known` and `n/a` result carries its exact signature in the code, and a different failure is a `fail`.
  `pending` is only S1 (MODF), R1 (REP) and the tail of V2 (FED-C).
- The lab ran on an internal network with no route out; nothing was sent to a real server. `make down` was run
  at the end; images are kept.

## 4. Decisions and deviations

1. The subnet is `44.255.99.0/24` (AMPRNet space). peblish refuses private ranges, so a public block on an
   `internal` network needs no overlay in the image. Not a deviation; the brief allowed the choice.
2. **Deviation:** Mbin's API users are OAuth2 `client_credentials` clients, each backed by a bot user, so they are
   `Service` actors. That is why a bot cannot vote down or boost, why M1/remote is `n/a` on Mbin, and why Mbin's
   boost (V1) is replayed by the rogue in the same wire shape (an `Announce` of a bare IRI by a person). A real
   Mbin boost needs a non-bot user; left open.
3. **Deviation:** S1 and R1 ship as `pending` stubs that say what they will assert; V2's tail (FED-C) is
   `pending` on the missing `Undo(Announce)` and author `Delete`.
4. **Deviation:** S2/in is Lemmy only. PieFed deletes an account through a form (the API stub does nothing) and
   Mbin by console command, which the runner cannot reach, so both are `n/a` with that reason.
5. D1 is three runner invocations around a `kill -s KILL` of `peblish-worker` done by the Makefile
   (`make interop-d1`), because a container cannot kill its sibling. The two address cases (private, loopback) cannot
   reach delivery: peblish refuses to learn an actor with such an inbox (`401 key_unknown`), so D1 asserts that
   and that nothing is ever sent there.
6. PieFed's remote users are aged by two days, and Mbin's Valkey is cleared, by the runner before every group
   (`peers/piefed-db.ts`, `peers/mbin-cache.ts`); X1 measures the PieFed cap on a user created after the aging.
7. X1 is pinned as a range: PieFed lists four or five of a new author's six posts (its two workers race on the
   daily count); Lemmy and Mbin list all six. The brief asked for "the fifth post"; the measurement is that the
   fifth sometimes gets through.
8. The retry correction: `delivery/policy.ts` gives ten attempts over 54,130 s, about 15 hours. I could not tie
   "at least 195 attempts" to any code, so INTEROP.md does not repeat it.
9. Mbin's FrankenPHP runs with `GOMAXPROCS=4`, four threads and two workers: with one Go thread per host core it
   hung or answered 503 under Rosetta on first start.
10. Cleanup treats an entry a scenario already deleted as done (the scenario closes it in the ledger), and
    checks every open Undo in the ledger on every invocation, whoever wrote it.
11. I ran `make reset` at the start, which removed the volumes and network of a stopped spike lab that belonged
    to `feddit-mvp-w1-md` (project `feddit-lab`). It was not running.

## 5. Requests to root

1. **Time bomb in tests (outside my write set).** `packages/core/src/remote/backfill.test.ts:14` and
   `packages/federation/src/backfill/backfill.test.ts:355,373` hard-code `2026-11-09T12:00:00Z` as "now" while
   the code under test compares with the database clock. They fail from 12:00 UTC on 2026-11-09 for everyone, so
   `pnpm check` cannot be green until they use a relative time or fake timers.
2. **Mbin never announces** (P3, C2, M1/in). Mbin sends a Create straight to a magazine's remote subscribers,
   so peblish records `skipped community.unannounced` and shows nothing. Decide whether peblish should take a
   Create addressed to a community it follows from the author's server, or document it as a limit.
3. **Mbin addresses a comment's Delete to the post's author first** (C1). peblish takes the first addressee for
   the community and records `skipped community.mismatch`; the comment stays. Same question as 2.
4. **Lemmy refuses `Update(Group)` from the community** (S3/out): `400 unknown variant "Group", expected one of
"Person", "Service", "Organization"`. FED-C or FED-B may want a shape Lemmy takes (an `Update` by a moderator,
   announced); Mbin answers 200 and keeps the old description.
5. **Account deletion** (S2/out): peblish's `Delete` of a person carries no `removeData`, so Lemmy keeps the
   account's posts visible. If "delete my content" should reach peers, the activity needs it.
6. **README ownership table:** add a row for LAB: `lab/**`, `tools/interop/**` and `INTEROP.md`, run by hand
   (`make check`), not in CI; CI runs only the unit tests of the package.
7. **Plan text:** row 11.5 (Mbin's boost is `announce.bare_iri`, not `announce.person`); the retry window is about
   15 hours, not 11 (item 8 above).
8. Payload routes: none. Throttle scopes: none. Settings keys: none. No migration, no change under `packages/**`.
9. Lockfile: the importer for `@peblish/interop` is its own commit (`f2e0819`).

## 6. Requests to other lanes, through root

- **MODF:** S1 needs an instance-wide ban that federates as a `Block` of the person with the instance as target,
  an inbound `Block` that applies or is refused with an exact reason, and a refusal when a site-banned user posts
  or comments in !lab. When it merges, replace the stub in `scenarios/pending.ts`.
- **REP:** R1 needs a `Flag` that opens a report (`inbound/handlers/flag.ts` ends in `flag.not_handled` today) and
  an outbound `Flag` for a report on a peer's post.
- **FED-C:** V2 needs `Undo(Announce)` and the author's `Delete` sent to a Mastodon-like follower when a post is
  deleted; the scenario already waits for both and turns into a pass.
- **ADM:** nothing needed from the lab. If ADM adds a site setting that changes federation (an allowlist), the
  lab's seeds and `INTEROP.md` switches table need a line.

## 7. Dependencies added

No third-party dependency. A new private workspace package, `@peblish/interop` (`tools/interop/package.json`,
AGPL-3.0-only), with dependencies already in the lockfile: `@peblish/{core,federation,schema}` (workspace),
`arktype` 2.2.9, `postgres` 3.4.9 and, as a dev dependency, `@fedify/fedify` 2.4.5 (allowed under `tools/`;
it signs the rogue's requests so a second implementation checks peblish's verifier).

## 8. For later lanes

- `make interop PEERS=lemmy ONLY=M1` narrows a run; `ONLY=Z1` also selects `Z1/N3`. Scenario results are in
  `lab/data/results/` (`interop.json`, `group-*.json`).
- `peblish.ts` in `tools/interop` is the driver: `as(name)` makes the principal, then call the `*As` wrapper
  or `authorize` plus the mutation; read `inbox_raw` and `deliveries` through `match.ts` (`expectInbound`,
  `expectDelivery`), which compares the exact `SkipReason` and fails with the outcome it got.
- A new scenario goes in `scenarios/<group>.ts`, is registered in `scenarios/index.ts`, and writes each thing it
  creates to `ctx.ledger` at creation (`ctx.ledger.done(id)` when it deletes it itself).
- PieFed lists a remote user's posts only after it has seen the user a day, hence the aging; and Mbin posts an
  activity id to an inbox once per 45 minutes, hence the cache clearing. A scenario that sends the same
  activity twice to Mbin will not see the second.
- Lemmy derives login tokens from a second-resolution `iat`; `peers/threadiverse.ts` retries the collision.
- The rogue poses as Mastodon (NodeInfo `mastodon`), so a rogue actor that follows !lab gets `Announce(Page)`.

## 9. Left open and risks

- S1 and R1 (above), a real Mbin boost with a non-bot user, Mbin account deletion (console), PieFed account
  deletion (form).
- Not covered, from the brief's list for LAB: a lost first Follow beyond F3's resend, Lemmy refusing
  `Announce(Page)` (only the rogue gets that shape), the 12 hour expiry of a remote moderator, dormancy
  (`instance_health`).
- X1 is a measurement of PieFed 1.8.11 with two workers; a different worker count may give another range.
- The lab needs 8 GB of Docker memory and runs amd64 images under Rosetta on Apple silicon; timing-sensitive steps
  (the 45 s waits, the 60 s lease) have margins, but a very loaded machine can still time one out, which shows as
  a `fail`, not a `known`.
- Seven product tests fail from today's clock (request 1); `pnpm check` is red until they are fixed.
