# Interop

peblish's federation is tested against three real servers in a local lab: Lemmy 0.19.21, PieFed 1.8.11 and
Mbin 1.11. The production Docker image (the root `Dockerfile`, no lab switch) runs against them for a full
round trip, and a rogue peer signs forged activities through the real inbox. This replaces the Fedify spike
(`spikes/`, kept as history). Plan row B02.

The lab is in `lab/` (see `lab/README.md`), the scenarios in `tools/interop/`. Nothing here touches the
internet: the lab network is `internal`, every name is under `.lab.test`, and no container has a route out.

## Run it

```sh
cd lab
make check          # reset, up, seed, interop, interop-d1, cleanup: about 20 minutes from nothing
make interop        # the fast tier against a running lab
make interop PEERS=mbin ONLY=Z1,P1
make interop ONLY=V2   # with V2/F5 and V2/F3, which need V2's follow of !lab
make interop-d1     # D1, the delivery schedule, with a SIGKILL of the worker in the middle
make interop-slow   # F3, the Follow resend at 5 and 15 minutes (about 17 minutes)
make cleanup        # put the lab back from the ledger
make down           # keep the images, drop the containers
```

Needs Docker with 8 GB of memory or more (the lab is about 6 GB) and a free port 18322 only if you run
`make ports`. The lab is a Docker singleton: one at a time, and `make up` refuses to start while the project
`feddit-lab` runs from another worktree. Results are written to `lab/data/results/` (`interop.json`, one
`group-*.json` per group, `ledger.jsonl`).

CI does not run the lab. It runs the unit tests of `tools/interop` (`pnpm test`): the matcher, the cleanup
ledger, the guards on the lab's configuration, and that every address of the lab network passes peblish's
public-address check.

## Topology

```text
runner ──▶ peblish-db ◀── peblish-web ◀─┐
   │                      peblish-worker ─┤        caddy (tls internal, one alias per host)
   │                                      ├──────▶ lemmy.lab.test    lemmy, lemmy-ui, db, pict-rs
   └─────────── HTTPS ───────────────────▶│       piefed.lab.test   web, celery, db, redis
                                          │        mbin.lab.test     php, messenger, db, valkey, rabbitmq
                      rogue.lab.test ◀────┘        peblish.lab.test
```

- The network `lab` is `44.255.99.0/24` and `internal`. peblish refuses to fetch from private ranges, so the
  lab uses a public block (AMPRNet space) that nothing routes to; no overlay or lab switch is needed in the
  image. A unit test checks that every address of the /24 passes `isPublicAddress`.
- peblish runs as the shipped processes: `peblish-migrate`, `peblish-web`, `peblish-worker`, with only the
  variables a deployment sets (`PEBLISH_PROCESS`, `DATABASE_URL`, `PUBLIC_ORIGIN=https://peblish.lab.test`,
  `BETTER_AUTH_SECRET`, `NODE_EXTRA_CA_CERTS`, `PEBLISH_TRUSTED_PROXY=traefik`). A unit test fails if the
  compose file gives peblish anything else.
- Only the worker delivers. The runner has no control surface on peblish: it calls core as a local user
  (`authorize`, then the mutation or its `*As` wrapper), exactly as the web tier does, and reads `inbox_raw`,
  `deliveries`, `follows`, `posts` and `deletion_ledger` to see what happened.
- The peers talk to peblish over HTTPS through Caddy, whose root certificate every container trusts.
- The rogue (`tools/interop/src/rogue.ts`) signs with Fedify's `signRequest`, a second implementation that
  checks peblish's own verifier. Its NodeInfo says `mastodon`, so a rogue actor that follows !lab stands for
  a Mastodon server.

### Switches on the peers

| Peer   | What the lab changes                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lemmy  | HTTPS (`tls_enabled`; release builds reject http federation URLs), `concurrent_sends_per_instance: 1`, rate limits at 10,000, image proxying off, federation allowlist of the lab hosts                                                                                                                               |
| PieFed | `RATELIMIT_ENABLED=false`, `VOTE_QUOTA` high, `FULL_AP_CONTEXT=0`, activity log to the database, allowlist set by `bootstrap.py`; `make interop` backdates remote users by two days so PieFed's day-one post limit does not decide the run (X1 is the exception and does not backdate)                                |
| Mbin   | FrankenPHP on `:80` behind Caddy with `TRUSTED_PROXIES=44.255.99.0/24`, no Mercure, `MBIN_USE_FEDERATION_ALLOW_LIST` with the lab hosts in the `instance` table, API users are OAuth2 `client_credentials` clients each backed by a bot user (Service actors); `make interop` flushes Mbin's Valkey first (see below) |

## Scenarios

`pass`, `fail`, `n/a` (the peer cannot do it), `known` (it fails exactly as a documented defect predicts; the
exact signature is in the code and a different failure is a `fail`), `pending(<lane>)` (waits for a lane that
has not merged).

| Id     | What                                                                                                                                                                                          | Peers                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| F1     | A peer's user follows `!lab@peblish.lab.test`; Accept arrives (Mbin through `/f/inbox`)                                                                                                       | all                        |
| F2     | A peblish user follows a community on the peer: pending, Accept, accepted; backfill done; moderators mirrored; Undo(Follow)                                                                   | all                        |
| F3     | Slow tier: an unanswered Follow is sent again at 5 and 15 minutes under fresh ids                                                                                                             | rogue                      |
| P1     | Text and link post, edit, delete show, change and vanish on the peer                                                                                                                          | all                        |
| P2, P3 | A peer's post is stored once and relayed to the other peers; PieFed serves `/activities/...`                                                                                                  | all                        |
| C1, C2 | Comments both ways, threaded, edited, deleted                                                                                                                                                 | all                        |
| V1     | Like, Dislike and Undo both ways; Mbin's boost arrives as `announce.bare_iri`                                                                                                                 | all                        |
| V2     | A rogue follower posing as Mastodon gets `Announce(Page)`, peers get `Announce(Create(Page))`, never both to one inbox; the post's delete sends it `Undo(Announce)` and the author's `Delete` | rogue, all                 |
| V2/F5  | A Lemmy admin's site ban of a Lemmy user with `removeData` takes the local community's boost of that user's post back from the Mastodon-like follower                                         | rogue, Lemmy               |
| V2/F3  | A post naming a Mastodon-like person who follows nothing, then removed by a moderator, reaches that person as the author's `Create`, then the author's `Delete`                               | rogue                      |
| N1     | A remote NSFW post: `content.nsfw_rejected`                                                                                                                                                   | all                        |
| M1     | Remove, restore, lock, feature, community ban and unban, moderator add and remove, both directions                                                                                            | all                        |
| Z1     | The authorization matrix N0 to N15 from the rogue through the real inbox (reasons as in `matrix.test.ts`)                                                                                     | rogue                      |
| B1     | A Dislike for an older post: `target.missing`, the missing-object job fetches it, the vote applies once                                                                                       | Lemmy, PieFed              |
| H1     | WebFinger by name and URL, NodeInfo, 410 Tombstones, an inbox URL with a query, signed GET                                                                                                    | peblish                    |
| S1     | Instance-wide ban both ways: a peblish site ban refuses the peer user's post as `auth.site_banned` and its Block and Undo reach the peer; a peer's ban of its own user applies here and lifts | all                        |
| S2     | Account deletion: peblish's reaches each peer with `removeData: false`; a Lemmy deletion with and without content gives a `remote.actor_deleted` ledger row                                   | all                        |
| S3     | `Update(Group)`: a peblish edit (the editor's Update, announced) shows on the peer, a peer's edit applies, a stranger's is `actor.update_unauthorized`                                        | all                        |
| R1     | Flag in (opens a report here) and out (a forwarded report reaches the peer; Lemmy lists it)                                                                                                   | all                        |
| D1     | The production delivery schedule and recovery after a SIGKILL of the worker                                                                                                                   | Lemmy, PieFed, Mbin, rogue |
| X1     | A new author's burst of posts, measured once and pinned                                                                                                                                       | all                        |

D1 in detail: a 400 is final at attempt 1; a 503 stays pending and the retry is about 10 s later; a redirect
is refused and not followed; an actor whose inbox is a private or loopback address is refused at the door
(`401 key_unknown`) and nothing is ever sent there; the same Announce reaches every peer on the first
attempt; a post made while the worker is dead is delivered once it returns; a POST in flight at the SIGKILL
is claimed again after the 60 s lease and delivered on attempt 2.

## Latest results

Run of 2026-11-10 (FX-INTEROP) against Lemmy 0.19.21, PieFed 1.8.11 and Mbin 1.11.0, from `make reset`:

- `make check` took 892 s (14.9 minutes): reset, up, seed, the fast tier, D1 and cleanup, on an
  Apple-silicon Mac under Rosetta for the amd64 images, with the machine busy with other work.
- Fast tier: 84 pass, 0 fail, 4 known, 8 n/a, 0 pending. D1: 8 pass. Cleanup: 73 cleaned, 0 failed.
- The run before the interop fixes (tag `w3-fixes`): 67 pass, 0 fail, 9 known, 6 n/a, 6 pending.

| Scenario                                                           | Lemmy    | PieFed        | Mbin     | Other           |
| ------------------------------------------------------------------ | -------- | ------------- | -------- | --------------- |
| F1 follow in, Accept                                               | pass     | pass          | pass     |                 |
| F2 follow out, backfill, moderators, Undo                          | pass     | pass          | pass     |                 |
| F3 Follow resend at 5 and 15 min (slow tier, not rerun)            |          |               |          | rogue: pass     |
| P1 post, edit, delete                                              | pass     | pass          | pass     |                 |
| P2 peer post stored once, relayed                                  | pass     | pass          | pass     |                 |
| P3 peer post shown to the others                                   | pass     | pass          | pass     |                 |
| C1 comments into peblish                                           | pass     | pass          | pass     |                 |
| C2 comments out of peblish                                         | pass     | pass          | pass     |                 |
| V1 votes both ways                                                 | pass     | pass          | pass     |                 |
| V2 Mastodon-like follower, Undo(Announce) and Delete               |          |               |          | rogue: pass     |
| V2/F5 a Lemmy site ban with removeData withdraws the boost         |          |               |          | rogue: pass     |
| V2/F3 a mentioned Mastodon-like person gets the author's Delete    |          |               |          | rogue: pass     |
| N1 remote NSFW post refused                                        | pass     | pass          | pass     |                 |
| M1/out peblish moderation shown on the peer                        | pass     | pass          | known    |                 |
| M1/in the peer's moderation applied                                | pass     | known         | known    |                 |
| M1/remote remote moderator add and remove                          | pass     | pass          | n/a      |                 |
| Z1 authorization matrix N0 to N15                                  |          |               |          | rogue: 16 pass  |
| B1 Dislike for an older post                                       | pass     | pass          | n/a      |                 |
| H1 WebFinger, NodeInfo, tombstones, inbox with a query, signed GET |          |               |          | peblish: 5 pass |
| S1/out peblish site-bans a peer's user                             | pass     | pass          | n/a      |                 |
| S1/in the peer site-bans its own user                              | pass     | known         | n/a      |                 |
| S2/out peblish account deleted                                     | pass     | pass          | pass     |                 |
| S2/in a Lemmy account deleted, content kept and removed            | pass (2) | n/a           | n/a      |                 |
| S3/out peblish edits the community                                 | pass     | pass          | pass     |                 |
| S3/in the peer edits its community                                 | pass     | pass          | pass     |                 |
| S3/unauthorized a stranger's Update(Group)                         | pass     | pass          | pass     |                 |
| R1/in a peer's Flag opens a report                                 | pass     | pass          | pass     |                 |
| R1/out a forwarded report reaches the peer                         | pass     | pass          | pass     |                 |
| D1 delivery schedule, SIGKILL of the worker                        |          |               |          | peblish: 8 pass |
| X1 new author's six posts                                          | pass (6) | pass (4 to 5) | pass (6) |                 |

`known` entries and what they mean (the exact signature is in the scenario code):

- M1/out on Mbin: it does not apply the Undo of a removal. M1/in on PieFed: it never federates an unban.
- M1/in on Mbin: its trash applies here as a removal, but its restore sends nothing.
- S1/in on PieFed: it sends a site ban only to piefed, pylova, lemmy and mbin instances.

`n/a` on Mbin: its API users are bots (Service actors), which cannot vote down, be made a peblish
moderator or be site-banned here, and its lab clients have no admin scope for a site ban; PieFed and
Mbin delete accounts outside their API (S2/in).

S1/out on Lemmy passes with Lemmy's `400 Site bans from remote instance can't affect user's home
instance` for the Block and its Undo: Lemmy refuses a remote ban of its own user by design.

D1 in detail, as measured: a 400 is final at attempt 1; a 503 is pending and the retry is 10 to 12 s
after the delivery was created; a redirect is refused and not followed; a post made while the worker
was dead reached all three peers once it returned; the POST in flight at the SIGKILL was claimed again
after the 60 s lease and delivered on attempt 2 (about 45 s after the restart).

## Known peer defects and product findings

Each one is a `known` entry in the code with its exact signature, or listed here as a limit of the lab.

Peers:

- **PieFed never federates an unban.** M1 in: after a community ban lifts on PieFed, peblish is never told
  (`timed out waiting for peblish to lift the ban`). Its moderator list is also cached, so the list is not
  asserted. Its API deletes an account only through the settings form (the API stub does nothing), so S2/in
  is `n/a`.
- **PieFed drops a Follow that arrives within seconds of an Undo(Follow)**; F2 waits for the Undo delivery
  and 8 s more. It also answers 200 and lists only four of a new author's six posts in a day (X1, pinned).
- **Lemmy refuses an `Update(Group)` sent by the community itself** with `400 unknown variant "Group",
expected one of "Person", "Service", "Organization"`: it parses the embedded object as a person. Lemmy,
  PieFed and Mbin all send their own community edits as an `Update(Group)` by the moderator, announced by
  the community, and peblish now does the same (S3/out passes on all three).
- **Lemmy keeps a deleted person's posts** unless the Delete carries `removeData: true`. A deletion in
  peblish keeps the account's content too, so its Delete says `removeData: false`; PieFed and Mbin hide
  the posts anyway (S2/out notes which).
- **Lemmy refuses a remote instance's site ban of its own user** (`400 Site bans from remote instance
can't affect user's home instance`), by design: peblish's Block and Undo for a Lemmy user are answered
  that way and the ban still holds here (S1/out).
- **PieFed sends a site ban only to `piefed`, `pylova`, `lemmy` and `mbin` instances** (by NodeInfo
  software), so peblish never hears of one (S1/in on PieFed is `known`).
- **Lemmy's first contact**: its outbound worker for a newly seen instance starts on a 60 s timer and skips
  every activity queued before it started, so `make seed` waits for the workers.
- **A Lemmy ban drops the banned user's subscription**, and Lemmy then rejects the community's Announces
  with `CommunityHasNoFollowers` once nobody there follows it. The scenarios keep a second follower.
- **Mbin never announces its own members' activity**: it sends a Create, Update or Delete straight to a
  magazine's remote subscribers. peblish now takes such an activity when it is signed on the community's
  host, addressed to the community, and the community is followed here (P3, C2 pass); an author on any
  other host still needs the community's Announce. **Mbin addresses a comment's Delete to the post's
  author before the community**; peblish now finds the community among every addressee (C1 passes).
- **Mbin's moderation is not announced either**: its trash is a bare Delete by the moderator with no
  reason, which now applies here as a removal, but a restore sends nothing (M1/in `known` at the
  restore). It also ignores the undo of a removal (M1 out), cannot be driven for a vote down, a boost,
  a site ban or an account deletion by its bot API users (V1 Dislike, B1, S1 and S2/in `n/a`; its boost
  is replayed by the rogue as the same wire shape), and treats a Like as a favourite.
- **Mbin posts an activity id to an inbox once per 45 minutes** and sends no Follow when a user subscribes
  again after unsubscribing, so F1 uses a fresh user per run and `make interop` flushes Valkey. Client
  creation is limited to two per six hours per IP, which the same flush resets.

peblish, as seen from the lab:

- **Delivery retries**: ten attempts per delivery over 54,130 s, about 15 hours (`policy.ts`: 10 s, 30 s,
  90 s, 270 s, 810 s, 2,430 s, 7,290 s, then 6 h twice). The plan's earlier "11 hours" was wrong. I could
  not tie the brief's "at least 195 attempts" to any code path, so it is not repeated.
- **Mbin's boost is `announce.bare_iri`**, not `announce.person` (plan row 11.5).
- **Private and loopback inboxes are refused at the door**: an actor whose inbox is such an address is never
  stored (`401 key_unknown`), so the address check at delivery time is covered by unit tests, not the lab.

## What the lab cannot show

- Real TLS, DNS, IP reputation, rate limiting by a CDN or a reverse proxy in front of a real instance.
- Mastodon, Pleroma, Lemmy 1.0 or kbin itself: the rogue only poses as Mastodon in NodeInfo, and a second
  Lemmy version is not run.
- Crowds: backfill of a large community, hot-instance fan-out, a hundred followers on one server.
- Retries that take hours, beyond the unit tests of the schedule and the two slow-tier resends.
- Media, link previews, email and the web UI (Playwright covers the UI).
