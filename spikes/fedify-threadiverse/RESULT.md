# Fedify threadiverse spike: result (gate G2, slices 1 to 3)

Run on 2026-11-08. Slices 1 and 2 ran in the local lab only; slice 3 also ran live, against feddit.com, piefed.social, fedia.io and lemmy.world (see "Slice 3 (live peers)").

Lab boundary:

- Every lab service sits on one Docker network that Docker marks `internal`, so no container has a route out of the lab. Caddy, the TLS front, is no exception (slice 2 change; in slice 1 Caddy was also on an ordinary network).
- Every hostname is under `.lab.test`.
- Host access is opt-in. `make ports` starts a TCP forwarder (`lab/forward.mjs`) that publishes 127.0.0.1 ports. While it runs, it is the only container with a route out, and it connects to Caddy only.

Versions:

| Component | Version |
|---|---|
| `@fedify/fedify`, `@fedify/hono`, `@fedify/postgres`, `@fedify/vocab` | 2.4.5 |
| Hono | 4.13.17 |
| Node | 24, in `node:24-bookworm-slim` |
| Lemmy and lemmy-ui | 0.19.21 |
| PieFed | 1.8.11, built from the `v1.8.11` tag |
| pict-rs | 0.5.16 |
| Caddy | 2.10 |

## Verdicts

### Slice 1: go

The gate: "Follow, post, comment, vote and undo, edit, delete round-trip both ways with Lemmy 0.19.21 and PieFed 1.8.11 in the Docker lab; cross-peer relay through the Feddit community works; workarounds and their cost are recorded."

The final clean run passed 32 of 32 scenarios, 16 per peer. Slice 2 added R6, a Feddit Page created, edited and deleted in each peer's community. The results:

- **Every direction and both community locations pass:**
  - Feddit content in Feddit's community
  - peer content in Feddit's community
  - peer content in the peer's community
  - Feddit content in the peer's community: comments and votes (R3, R5) and posts (R6)
- **Cross-peer relay** through `!spike` works from Lemmy to PieFed and back, for create, edit and delete.
- **Relay fidelity.** Every relay sent the JSON Feddit received, structurally identical (compared field by field, after parsing). It is not byte-identical, because the Announce wrapper is re-serialised.
- **Delivery totals.** The slice-1 run alone made 60 outbound deliveries, every one answered 200, and received 40 inbound deliveries, every one answered 202. The whole sequence, including moderation and the deliberately broken inboxes, is under "Durable delivery and the restart test".
  - Correction to the slice-1 report: its 99 outbound and 66 inbound included the moderation runs. Its scenario run alone made 54 and received 35. This run's counts are higher mainly because of R6.

### Slice 2: go, with three peer-side exceptions

The gate: "Mod remove and restore, lock, community ban and unban, sticky, report round-trip; raw captures kept."

| Set | Result |
|---|---|
| Moderation (Feddit moderates, the peer moderates its own community, a peer user moderates Feddit's community) | 38 of 39 applicable pass; 1 `known` (M4 unban on PieFed), 1 `n/a` (P4 on PieFed) |
| Authorization refusals | 16 of 16 (the N0 control plus 15 refusals) |
| Delivery policy and crash recovery | 11 of 11 |
| Collision and instance actor | 7 of 8; 1 `known` (C1 on Lemmy) |

The exceptions are peer behaviour, recorded as `known` or `n/a` rather than hidden:

1. **PieFed's unban never federates.** PieFed 1.8.11's unban Celery task crashes (M4, `known`).
2. **PieFed bans only locally.** PieFed's API refuses to ban in a community it does not host, so a PieFed moderator of `!spike` cannot ban from PieFed (P4, `n/a`).
3. **PieFed's moderator list goes stale.** PieFed's API keeps serving a cached list after a federated Add. P0 records this; P1 to P3 show that PieFed still grants the new moderator its rights.

Lemmy's collision case C1 stays `known` (see the Actor URL decision).

What the product must carry from this spike:

- **Its own durable outbox**, instead of Fedify's delivery path.
- **One authorization module** for every inbound mutation, with origin rules on everything Feddit did not receive from the author.
- **Raw-JSON handling** for the activity types Fedify cannot model, such as Lock.
- **An instance actor** at `/`.

### Slice 3: go

The spike ran unchanged on the public internet as `https://lab.feddit.com` (Easypanel, Traefik TLS, the Dockerfile in this directory) against the production PieFed 1.8.11 at feddit.com behind Cloudflare, and follow-only against piefed.social (PieFed 1.8.11), fedia.io (Mbin 1.11.0) and lemmy.world (Lemmy 0.19.21). Run 1108042615 passed 11 of 12 checks: follow, post, comment, vote and undo, edit, delete, lock, unlock, remove with reason, restore, the reverse direction into a feddit.com community, and cleanup all round-trip with feddit.com, each delivery answered 200 on the first attempt; piefed.social and fedia.io accepted the lab's Follow. lemmy.world took the first Follow (200) but never answered it, and accepted a second Follow ten minutes later in about 34 s (the Lemmy first-contact skip from the slice 2 notes, now confirmed). After the review-driven hardening round, validation run 1108045930 passed all 12 checks, lemmy.world included, and its cleanup passed 11 final-state checks. The first run (1108035717) failed every outbound delivery and found a real defect: the delivery guard blocked all of IPv4 (fixed in `c185711`, unit test added). Details in "Slice 3 (live peers)".

## How to reproduce

```sh
cd lab
make check        # reset up seed scenarios moderation collision durability captures
```

Or step by step:

```sh
make reset        # down -v, delete lab/data
make up           # build the Feddit image (PieFed only if its image is missing), start 12 containers
make seed         # admins, users, !lab (Lemmy), !pflab (PieFed), !spike and alice/bob (Feddit)
make scenarios    # S1-S9, S8b, R1-R6      -> captures/results.json
make moderation   # S10-S14, M0-M4, P0-P5  -> captures/moderation-results.json, captures/moderation/
                  # then N0-N15            -> captures/authz-results.json, captures/authz/
make collision    # C0-C3, I1              -> captures/collision-results.json
make durability   # D3-D7, SIGKILL, D1-D2  -> captures/durability-results.json
make captures     # peers' own logs and instance records -> captures/
make stats        # memory per container
```

`make check` exited 0. Wall-clock time for the final run, 5 min 31 s in all:

| Step | Time |
|---|---|
| reset, up and seed | 1 min 38 s (images cached; seed waits for Lemmy's outbound workers) |
| scenarios | 59 s |
| moderation | 93 s |
| refusals | 20 s |
| collision | 4 s |
| durability, including the SIGKILL and restart | 49 s |

## Slice 3 (live peers)

Date 2026-11-08. Runner `scenarios/live.ts` from a laptop (see `LIVE.md`); lab at `https://lab.feddit.com` on Andrew's Easypanel (project `feddit-lab`: app `lab` built from this directory's Dockerfile, Postgres 16; Traefik terminates TLS and forwards plain HTTP with the Host header; DNS-only A record in the feddit.com Cloudflare zone). Env: `FEDDIT_ORIGIN=https://lab.feddit.com`, `FEDDIT_CONTROL_TOKEN` set, production delivery policy, no lab switches. Peers: feddit.com (PieFed 1.8.11, Cloudflare proxied with Browser Integrity Check on), piefed.social (PieFed 1.8.11), fedia.io (Mbin 1.11.0), lemmy.world (Lemmy 0.19.21-8-g081ada9cf). No public Lemmy 1.0 instance existed to test against: lemmy.world, lemmy.ml, programming.dev, lemmy.ca, sh.itjust.works, lemmy.dbzer0.com, feddit.org and lemmy.zip all reported 0.19.21 on 2026-11-08. Test account: `peblish_test` (non-admin) on feddit.com. Posting only into `!lab@lab.feddit.com` and feddit.com's `!microblogs`; third-party instances were only followed.

### Live matrix (run 1108042615)

| ID | Check | Peer | Result | Seconds | Note |
| --- | --- | --- | --- | --- | --- |
| L1 | PieFed resolves `!lab@lab.feddit.com` | feddit.com | pass | 0.4 | community 167 |
| L2 | Test account follows; lab stores follower; Accept delivered | feddit.com | pass | 2 | Accept to the follower's personal inbox, 200 |
| L3 | Lab text and link posts appear with title, Markdown body, author, url | feddit.com | pass | 4.5 | posts 198617, 198618; Announce 200 |
| L4 | PieFed post into the lab community and comment on the lab post, stored once | feddit.com | pass | 2.5 | post 198619, comment 3300444; both arrived direct |
| L5 | Like from PieFed stored, then undone | feddit.com | pass | 2 | displayed score 1 to 2 to 1 (the author's own vote is the 1) |
| L6 | Lab edit shows; lab delete hides | feddit.com | pass | 1.8 | Update and Delete via Announce, 200 |
| L7 | Lab moderator locks, unlocks, removes with reason, restores | feddit.com | pass | 5.1 | all four states shown on PieFed |
| L8 | Lab author follows `!microblogs@feddit.com`, posts into it; PieFed comment comes back | feddit.com | pass | 7.7 | post 198620; comment 3300445 arrived via the community's Announce |
| L10 | Follow only | lemmy.world | fail | 182 | Follow POST answered 200; no Accept in 180 s; retry below |
| L10 | Follow only | piefed.social | pass | 187 | Accept received; the only inbound activity in the 180 s window |
| L10 | Follow only | fedia.io | pass | 186 | Accept received; Mbin shared inbox `/f/inbox` |
| L9 | Cleanup: delete the run's content, unfollow everywhere | feddit.com | pass | 6.5 | 5 checks; PieFed marks the lab's deletions `deleted_by` the lab author's user row |

Lab outbox for the run: 19 deliveries, all `delivered` on attempt 1 with HTTP 200 (Accept, 8 Announce, Follow x4, Create, Delete, Undo x4). PieFed's outbound log to the lab: Follow, Create x2, Like, Undo, Accept, Announce, Delete x2, Undo, all 202 from the lab's Fedify inbox. feddit.com's app log shows no errors during the run. After cleanup feddit.com shows 0 visible posts in `!microblogs`, both test comments deleted, `peblish_test` with no memberships; the lab's L3 text post (198617) stays visible in feddit.com's copy of `!lab` by design.

Lemmy first-contact retry: a second Follow to `!fediverse@lemmy.world`, sent about ten minutes after the first, was accepted in about 34 s (run 1108042615, `--only=L10`, 600 s window); the first Follow never received an Accept in more than six minutes, which confirms the slice 2 risk note.

### Defect found by the live run

Run 1108035717 (2 of 12): PieFed resolved and followed the lab and its Follow was accepted, but every outbound delivery failed before any network call with `feddit.com resolves to a blocked address 172.64.80.1` (likewise lemmy.world 104.26.8.209, piefed.social 103.16.129.132, fedia.io 144.76.91.164). Cause: `net.BlockList` tests an IPv4 address against every IPv6 rule through its IPv4-mapped form, so the `::ffff:0:0/96` entry in `src/safe-post.ts` matched all of IPv4. The lab never showed it because `FEDDIT_LAB_CIDR` is checked first and every lab peer sits in that range, so the public branch of the guard had never run before this slice. Fix (`c185711`): drop the rule, unmap `::ffff:a.b.c.d` to IPv4 and judge it with the IPv4 rules; `test/safe-post.test.ts` (`npm test`) covers public, special-purpose, mapped and lab-subnet cases. Review finding 2 (incomplete IPv6 exclusions) was then closed in the hardening round below: `fec0::/10`, `64:ff9b:1::/48`, `2002::/16` and `::/96` are blocked and tested; newer IANA entries such as `3fff::/20` are not listed. The Phase 1 requirement for one shared public-address predicate stands.

### What the live peers showed

1. Cloudflare in front of feddit.com does not interfere with federation: Fedify-signed POSTs, actor fetches and the alpha API pass; the Browser Integrity Check blocks only the `Python-urllib` user agent.
2. PieFed accepts a brand-new instance at once: actor fetch, Follow, Accept, Announce, direct Create, Like, Undo, Update, Delete, Lock, remove and restore from a community it had never seen, with no probation. Its instance row recorded `feddit-spike 0.0.1` from NodeInfo.
3. The reverse direction works against a real PieFed community: the lab author's Follow of `!microblogs` was accepted, its post was accepted (PieFed delivered a Create-shaped record and lists it under the lab author's PieFed user row 91303), and a PieFed comment on it reached the lab through the community's Announce.
4. The PieFed day-one cap (4 posts per new remote account) was not reached: a run makes 3 posts per fresh author. Measuring the cap would mean spamming production, so it stays unmeasured and the Phase 2 design keeps the per-run fresh author.
5. Lemmy first contact: lemmy.world's inbox accepted the Follow POST at once, but no Accept arrived within 180 s and the lab saw no actor fetch from lemmy.world in that window, which matches the slice 2 risk note (Lemmy's outbound worker for a newly seen instance starts on a timer and may skip what was queued before it). piefed.social and fedia.io answered within their windows.
6. Mbin 1.11.0 (fedia.io) accepted a Follow from a Fedify Person through its shared inbox `/f/inbox`; nothing else was exercised with Mbin.
7. Mastodon: not yet exercised; the lab stays deployed until Andrew's account has followed `@labmod@lab.feddit.com` or `!lab@lab.feddit.com` and replied.

### Review of the live batch and the hardening round

An independent static review (Codex, 2026-11-08) of the slice 3 batch found two P1s that mattered while the lab was public: every POST to a path ending in `/inbox` was buffered and captured before authentication and without limits, and the delivery guard still admitted the transition ranges. It also found three P2s in the runner (ids not bound to the deployment, cleanup able to pass with work left, creation tracking lost on partial failure and able to exceed PieFed's day-one cap) and documentation that overstated the evidence. The lab was stopped on Easypanel until the fixes were deployed (commit `21377b7`): only `/inbox` and `/ap/<id>/inbox` are read and captured, bodies over 512 KiB get 413 (chunked bodies included), capture files stop growing at 64 MiB, the four ranges are blocked, Accept only marks a pending `following` row that matches both follow id and community, and Reject only deletes a row that matches follow id and actor, the server warns at startup when the control token is unset off the lab domain, and the runner binds its ids file to the deployment, verifies ownership and the run prefix before every deletion, saves each creation at once, refuses a fourth post per author, reverses leftover votes, locks and removals, and asserts the final state in cleanup with a full `/spike/state` snapshot written per run. Tests: `npm test` (guard ranges, body limit and 413, capture bounds, follow handlers; the follow test needs `TEST_DATABASE_URL`). The second Accept from piefed.social seen during the retry answered a fresh Follow that the retry run had sent (the wrapper's env file overrode the single-handle setting), not the earlier Undo; the handler hardening is defence in depth.

### Validation run 1108045930 (hardened build)

All 12 checks passed: L1 to L8 against feddit.com in 0.4 to 5.1 s each (posts 198624, 198625, 198626, 198628; comments 3300546, 3300547), lemmy.world accepted the Follow in about 26 s (the instance was known to it by then), piefed.social and fedia.io accepted theirs, and L9 passed 11 final-state checks (deletions on both sides, no follower or following rows left, every Undo delivered, no votes left; the unlock and restore checks did not run because L7 had already cleared its flags). Lab outbox for the day: 44 delivered, 11 failed (all 11 from the first run's guard defect). Real traffic reached the lab during the piefed.social observation window, although it came from lemmy.world: `!fediverse@lemmy.world` announced a Dislike by a piefed.social user and then its Undo. The lab verified both Announces, ignored the Dislike (`unknown target`: the lab holds none of the community's earlier posts because it does no backfill) and rejected the Undo (`announced by https://lemmy.world/c/fediverse, but the target has no community`), with no errors. Both outcomes are the intended behaviour for a follower without context; Phase 2 adds collection backfill (FEP-7888) so such activities find their target. Evidence: `captures/live-1108045930.json`, `captures/live-1108045930-ids.json`, `captures/live-1108045930-state.json` (local, gitignored). The earlier run's result file `live-1108042615.json` was overwritten by its `--only=L10` retry, so its 11 of 12 scoreboard survives only in the console log `captures/live-console-2026-11-08.log`; the runner now writes one result file per invocation.

Open items from the follow-up review (cleanup recovery, not fixed in Phase 0): a cleanup retry does not re-check Undo deliveries from an earlier failed cleanup, because `unfollow` deletes the local row before delivery completes; a vote that PieFed accepted but whose Like never reached the lab is not cleared on PieFed; a partially completed L8 whose PieFed id was never discovered skips the remote visibility check. All three are runner-side (`scenarios/live.ts`) and go to the Phase 2 scenario harness (B02) with the carry-forward list.

Operational notes: the Easypanel GitHub integration built the Dockerfile from the private repository's `slice-3-live` branch in under a minute (layers cached); the runner needed a per-process DNS pin because the laptop's Tailscale MagicDNS kept a negative answer for the new name; `services/app/updateMounts` is gone in this Easypanel version (`mounts/createMount`), and the panel's `status` helper prints the service env unredacted, so inspect through a redacting wrapper. Teardown after the Mastodon check: `node scenarios/live.ts --cleanup --run=<id>` for any run left with `--keep`, delete the lab's remaining L3 posts, destroy the Easypanel project, delete the DNS record, delete `peblish_test`.

## Slice 2

### What changed in the design

1. **Delivery: a durable outbox of Feddit's own** (`src/outbox.ts`, `src/safe-post.ts`). Every activity Feddit sends is now a row per (activity, inbox):
   - **Claiming.** A worker claims due rows with `FOR UPDATE SKIP LOCKED` under a lease. It signs each once with draft-cavage-12 and records status, attempt count and the last answer.
   - **Retry policy:**
     - 400, 403, 404, 405, 410, 413, 422, any 3xx, and a refused destination are final;
     - 401, 408, 429, 5xx and network errors are retried with backoff (×3) and capped. The default is 10 attempts over about 11 hours; the lab uses 4 attempts over about 13 s.
   - **Crash recovery.** A worker that dies mid-POST leaves its lease to expire, and the row is sent again. That is at least once; receivers de-duplicate by activity id.
   - **Why not Fedify's queue.** Fedify 2.4 can run custom tasks on its queue, but `@fedify/postgres` deletes a message before its handler runs (`mq.js`, `DELETE ... RETURNING` and then `handler(row.message)`). A crash mid-delivery therefore loses it: at most once.
   - **Why not Fedify's sender.** It double-knocks (below) and would still re-serialise relays.
   - **What stays with Fedify:** actors, collections, WebFinger, NodeInfo, signature verification and the inbound queue.
2. **Delivery safety** (`src/safe-post.ts`, review finding 2). Inbox URLs come from remote actor documents, so each POST:
   - is https only;
   - has its host resolved once, with every address required to be public (IANA special-purpose blocks refused). The checked address is the one connected to, so there is no window for DNS rebinding;
   - never follows a redirect;
   - has a 15 s timeout and reads at most 64 KiB of the response.
   
   The lab allows exactly `FEDDIT_LAB_CIDR=192.88.99.0/24` on top of public space, so loopback and RFC 1918 stay refused in the lab too (D7). Fedify's own fetches still run with its all-or-nothing `allowPrivateAddress` in the lab; production leaves it off.
3. **Inbound: one pipeline** (`src/inbox.ts`) and **one authorization module** (`src/authz.ts`):
   - **Trust.** A direct delivery is trusted as signed: Fedify checks that the signing key belongs to the actor (N9). An activity unwrapped from an Announce, or embedded in an Undo, is trusted only when its id shares the container's origin. Any other copy is fetched from the activity's own origin (N11).
   - **Origin rule.** The activity's id and actor must then share one origin (N7, N10). Created and updated objects must live on their author's origin (N2).
   - **Once only.** Echoes of our own activities are skipped by origin before any fetch. Every applied activity id is recorded (`processed_activities`), so direct and announced copies apply once. Lemmy sends a ban both ways. The claim on an id is released unless the activity was applied, so a rejected forgery cannot burn a real activity's id.
   - **Rights:**
     - owner: the actor wrote the target;
     - community: the actor is the community;
     - moderator: our table for local communities (`community_moderators`, by actor URI, so remote users can moderate a Feddit community); for remote communities, the collection the community publishes on its own origin, cached and refetched on a miss.
     
     Every handler names the rights it accepts. An announced activity must also come from the community its target belongs to (N12).
   - **Reports.** A report must be about content stored here, in a community hosted here (N8).
   - **Bans and locks.** Local communities enforce their bans and locks on inbound content (N14, N15) and on local authors.
   - **Refusals** go to `inbox_log` and to `captures/rejected.jsonl` with the raw activity.
4. **Moderation handlers.**
   - **Types handled:** Delete with `summary`, or by a non-author (removal); Undo(Delete) (restore, or undelete by the author); Lock and Undo(Lock); Add and Remove on `featured` (sticky) and on `moderators`; Block and Undo(Block) with `target` = community, including `removeData` and `expires`; Flag, into a reports queue.
   - **Relays.** In a local community, every applied action that arrived directly is relayed through the community as an Announce of the original JSON. That is the path Lemmy and PieFed expect for remote moderators (P1 to P4).
   - **Raw JSON.** Lock is handled from the raw JSON, because Fedify parses it as a bare Activity at the top level and as a bare Object inside Undo or Announce.
5. **Instance actor** (`src/instance.ts`):
   - an `Application` at `https://feddit.lab.test/`, with key `/#main-key` and inbox = the shared inbox;
   - `preferredUsername` = the host, and `name` = NodeInfo's `nodeName` in 2.0 and 2.1;
   - an empty `/outbox`.
   
   Lemmy now stores Feddit's site (name, actor id, inbox, key) instead of logging "Failed to dereference site". PieFed stores the inbox and outbox from it. See `lemmy-instance-feddit.json` and `piefed-instance-feddit.json`.
6. **Smaller changes:**
   - Persons also get a `featured` collection, which silences Fedify's warning on every Person fetch.
   - The PieFed Celery health check is fixed (item 6).
   - `make up` no longer rebuilds PieFed from Codeberg when the image exists. Codeberg answered 503 during this run.

### Moderation matrix

Results are in `captures/moderation-results.json`, with the exact activities in `captures/moderation/`.

M1 to M4 now assert the exact activity that arrived:

- `Announce` from the peer's community, carrying the expected inner type;
- the inner activity by the peer's moderator, about this object, with this target;
- for an Undo, the undone type and object;
- answered with 202.

They also assert Feddit's resulting state, so a suppressed or mis-applied activity fails.

| ID | What happens | Wire activities | Lemmy | PieFed |
|---|---|---|---|---|
| S10 | Feddit's moderator removes a peer user's post in !spike, then restores it | Announce(Delete with summary), Announce(Undo(Delete)) | pass | pass |
| S11 | Feddit's moderator locks, then unlocks, a post | Announce(Lock), Announce(Undo(Lock)), raw JSON | pass | pass |
| S12 | Feddit's moderator bans, then unbans, the peer user in !spike | Announce(Block, target = community), Announce(Undo(Block)) | pass | pass |
| S13 | Feddit's moderator features, then unfeatures, a post | Announce(Add, target = featured), Announce(Remove) | pass | pass |
| S14 | The peer user reports a Feddit post | Flag from that user about that post (202); Feddit queues a report for !spike with the reason | pass | pass |
| M0 | A Feddit user follows the peer's community | Follow, then an Accept matched to this follower and this Follow id | pass | pass |
| M1 | The peer's moderator removes, then restores, a post in its own community | Announce(Delete), Announce(Undo(Delete)); Feddit marks it removed, then restored | pass | pass |
| M2 | ... locks, then unlocks | Announce(Lock), Announce(Undo(Lock)); Feddit locks and unlocks | pass | pass |
| M3 | ... features, then unfeatures | Announce(Add), Announce(Remove) on the community's featured collection; Feddit stickies and unstickies | pass | pass |
| M4 | ... bans, then unbans, the Feddit follower | Announce(Block), Announce(Undo(Block)); Feddit records and lifts the ban | pass | ban pass, unban `known`: PieFed never sends it |
| P0 | Feddit's moderator adds the peer user as a moderator of !spike | Announce(Add, object = person, target = moderators) | pass | pass (PieFed's API keeps its cached list) |
| P1 | That remote moderator removes, then restores, the other peer's post in !spike, from its own server | Delete or Undo(Delete) to !spike; Feddit authorizes it against its list, applies it and relays it; the other peer shows it | pass | pass |
| P2 | ... locks, then unlocks | Lock or Undo(Lock), relayed | pass | pass |
| P3 | ... features, then unfeatures | Add or Remove on featured, relayed | pass | pass |
| P4 | ... bans, then unbans, the other peer's user in !spike | Block or Undo(Block), relayed; the banned user cannot comment on the other peer, then can again | pass | `n/a` (PieFed's API: "Community not local to this instance") |
| P5 | Feddit's moderator removes the remote moderator | Announce(Remove, target = moderators) | pass | pass |

### Authorization matrix

Results are in `captures/authz-results.json`, with each case in `captures/authz/` and every refusal in `captures/rejected.jsonl`.

The rogue lab peer (`rogue.lab.test`, `scenarios/rogue.ts`) signs every case with a real key. N0 is the control: a valid comment from the same actor is stored. Each refusal case asserts three things:

- the `inbox_log` outcome is a rejection;
- the target is unchanged;
- the raw activity is in `rejected.jsonl`.

| ID | Attempt | Feddit's answer |
|---|---|---|
| N0 | Control: mallory comments on a !spike post | stored and announced |
| N1 | A non-moderator removes a post (Delete with summary) | rejected: not moderator or community |
| N2 | A non-author edits a post (Update embedding the post) | rejected: Fedify refetched the post from its origin; it is not on the actor's origin |
| N3 | A non-moderator locks a post | rejected: not moderator or community |
| N4 | A non-moderator features a post | rejected |
| N5 | A non-moderator bans a user | rejected; no ban recorded |
| N6 | A non-moderator adds itself to the moderators | rejected; the list is unchanged |
| N7 | Undo of another actor's vote | rejected: the undone activity's id and actor are on different origins |
| N8 | A report on content in another server's community | rejected: not in a community hosted here |
| N9 | A Delete claiming another actor, signed with mallory's key | 401 from Fedify: the key owner is not the actor |
| N10 | A followed Group announces a Delete whose id is on its own origin but names Lemmy's author (review finding 1) | rejected: id and actor origins differ; the post remains |
| N11 | A followed Group announces a Delete claiming an id on Lemmy's origin | rejected: fetched from Lemmy, it does not exist |
| N12 | A followed Group announces a post addressed to Lemmy's !lab | rejected: announced by a group that does not own the community |
| N13 | An Announce from an actor nobody here follows | rejected |
| N14 | A user banned from !spike comments | rejected: banned |
| N15 | A comment on a locked post | rejected: locked |

### Durable delivery and the restart test

Results are in `captures/durability-results.json`.

**Setup.** Rogue fixture actors follow !spike, so a single Announce is delivered at once to Lemmy, PieFed and seven inboxes that misbehave in known ways.

**Crash.** `make durability` kills the Feddit container with SIGKILL between the two phases and starts it again. At that moment one delivery is mid-POST (a slow inbox) and nine are held in the queue.

| ID | Inbox | Expected and observed |
|---|---|---|
| D3 | Always 400 | One attempt, then failed |
| D3b | Same | Exactly one POST (no second signature scheme) |
| D4 | Two 503s, then 202 | Delivered on attempt 3 |
| D5 | Always 503 | Four attempts (the lab cap), then failed |
| D6 | 307 to another URL | Failed after one attempt; the redirect target received nothing (D6b) |
| D7 | `localhost` (resolves to 127.0.0.1 and ::1) | Refused before connecting |
| D7b | `10.20.30.40` (RFC 1918) | Refused before connecting |
| D7c | Lemmy and PieFed | Same Announce, delivered on the first attempt |
| D1 | Nine deliveries queued at SIGKILL | All sent after the restart; the post shows on Lemmy and PieFed |
| D2 | A delivery in flight at SIGKILL | Re-claimed when its lease expired and delivered on attempt 2. The inbox saw the same activity id twice (at least once) |

Delivery totals for the whole sequence:

- **Outbound: 194 attempts.** 155 were answered 2xx. All 39 others are intended:
  - 20 × 503, 4 × 400 and 4 × 307 from the rogue fixtures;
  - 8 refused before connecting (the loopback and RFC 1918 fixtures);
  - 3 × 400 from Lemmy for activities about the rogue's account, which Lemmy never sees, because `rogue.lab.test` is not on its allowlist:
    - the relay of the rogue's control comment ("not in allowlist");
    - the ban of that account and its Undo, from the N14 setup ("Object was not found in local database").
- **Inbound: 125 deliveries.** 124 were answered 202, and 1 got 401 (N9, a signature that is not the actor's).

All 41 relays sent the JSON Feddit received, structurally identical.

### Echo and duplicate handling

Feddit skips its own activities when they come back, by origin and before any fetch. It also records every applied activity id, so a second copy is dropped. In the final run:

- 10 echoes from Lemmy were skipped;
- 2 second copies of already-applied activities were dropped (Lemmy's direct-plus-announced ban and unban);
- the Fedify log has 2 ERROR records, both from refusal cases: the N9 signer mismatch, and N11's fetch of a Lemmy activity that does not exist. The slice-1 run before the echo fix had 117, all from echo retries.

### Review findings and what changed

| # | Finding | Change |
|---|---|---|
| P1.1 | Unwrapped inner activities were not origin-checked | Trust and origin rules in `inbox.ts` and `authz.ts` (design change 3). N10 is the requested case; N2, N7, N11 and N12 cover the variants |
| P1.2 | Raw relays used global fetch to follower-chosen URLs | All delivery goes through `safe-post.ts` (https only, resolved and pinned public addresses, no redirects, timeout, response cap) and the durable outbox. D6 and D7 are the redirect and private-address fixtures |
| P1.3 | Caddy was on a non-internal network | Every lab network is internal. Host access is the opt-in `host-ports` forwarder. The boundary is stated at the top of this file and in `lab/README.md` |
| P2.4 | M1 to M4 and S14 accepted any inbound record | Exact type, actor, object, target, Undo contents, status and Feddit state are asserted (see Moderation matrix) |
| P2.5 | Follow assertions accepted any accepted row | R1, M0 and the authz setup now match the new local follower and the specific Follow id |
| P2.6 | No Feddit Page in a peer's community | R6: create, edit and delete of a Feddit Page in `!lab` and `!pflab`, with author, title and body asserted on the peer |
| P2.7 | Wording | "Structurally identical" relays; the subnet passes Lemmy's checks by choice of range, not a flag; delivery totals split by slice (Verdicts) |

The automated sequence keeps the negative scenarios: `make moderation` runs `authz.ts`, and `make check` runs everything.

### Time spent

Slice 2 took about 1 hour 15 minutes of wall-clock time, well inside the one-day box. Both slices together took about 6.5 hours. The times below are approximate, because the items overlapped.

| Item | Time |
|---|---|
| 6. PieFed Celery health check (lab configuration: the image's web health check ran in the worker container) | 2 min |
| 3. Durable outbox, retry policy and single knock; plus review P1.2 delivery safety | 12 min, including two regressions from leaving Fedify's sender (below) |
| 1 and 2. Inbound moderation handlers, authorization module, origin rules (review P1.1) | 15 min |
| Rogue peer and refusal scenarios N0-N15 | 10 min, including two findings: Fedify needs an extractable key to sign, and an outbound ban had not been recorded locally |
| Durability scenarios and the SIGKILL test | 7 min |
| 4. Instance actor | 4 min |
| 5. Echo by origin and duplicate suppression by id | in 1 and 2 |
| Review P2.4-P2.6: exact assertions, R6, P0-P5, `known` and `n/a` results | 10 min |
| Review P1.3: internal networks and the host forwarder | 4 min |
| Codeberg outage (PieFed rebuild) | 2 min |
| Clean runs and this write-up | 9 min |

Two regressions came from leaving Fedify's sender, and both were caught by slice-1 scenarios. Fedify's `sendActivity` silently normalises its compacted JSON-LD, and plain `toJsonLd({ format: "compact" })` does not:

- The Public collection came out as `as:Public`. Lemmy answered `object_is_not_public`.
- A one-element `attachment` came out as an object. Lemmy answered with its untagged-enum error, and S9 failed.

Feddit's outbox now applies the same two rewrites. Fedify's own helper, `normalizeOutgoingActivityJsonLd`, is not exported.

### Fedify behaviours worth an upstream issue

Each comes with minimal repro notes for Fedify 2.4.5.

1. **Retries of permanent 400s.**
   - Default: `permanentFailureStatusCodes` is `[404, 410]`, so a 400 is retried up to 10 times over hours.
   - Repro: `createFederation` with defaults, then `sendActivity` to an inbox that always answers 400 (Lemmy 0.19 does this for a strict-parse failure). The outbox queue re-sends with exponential backoff. `session-1-debugging/outbound.jsonl` lines 18 to 122 show one activity sent 20 times in 12 minutes.
   - Ask: default to all 4xx except 401, 408 and 429.
2. **Second signature attempt on any failure.**
   - Where: `doubleKnockCore` (`http-*.mjs`) re-signs with the other spec whenever the status is 400, 401 or above, even with `firstKnock: "draft-cavage-http-signatures-12"`, even when that spec is remembered for the origin, and for non-authentication failures such as a 400 parse error, 404 or 503.
   - Effect: Lemmy 0.19 cannot verify RFC 9421, so the second request fails with "Incoming activity has invalid digest for body". That masks the real error and doubles the traffic.
   - Repro: `firstKnock: "draft-cavage-http-signatures-12"`; send an Announce that Lemmy rejects as a 400 parse error. There are two POSTs, and the second answers "invalid digest".
   - Ask: double-knock only on 401, and skip it once a spec is remembered.
3. **No Lock type.**
   - At the top level: Lemmy's and PieFed's `Lock` (sent with Lemmy's context) parses as a bare `Activity`.
   - Embedded in Undo or Announce: it parses as a bare `Object`, whose `toJsonLd()` re-serialises it as `"type": "Object"`, so the type is lost.
   - Repro: `(await Undo.fromJsonLd({ type: "Undo", actor, object: { type: "Lock", id, actor, object } })).getObject()` gives an `Object`, and the Lock is not recoverable from it.
   - Ask: a `Lock` vocabulary type (Lemmy extension), or a raw-JSON accessor for embedded objects.
4. **No Lemmy moderation vocabulary.**
   - Missing: `moderators` (lemmy:moderators), `postingRestrictedToMods`, `stickied`, `removeData` and `expires` on Block, `distinguished`, and `featured` when the sender's context does not define it (PieFed).
   - Repro: `Group.fromJsonLd(<Lemmy community JSON>)` has no accessor for `postingRestrictedToMods`. `new Block({ ... })` cannot carry `removeData`. A PieFed Group's `featured` is dropped because PieFed's minimal context does not define `toot:featured`.
   - Ask: an optional Lemmy vocabulary module.
5. **At-most-once Postgres queue** (`@fedify/postgres`).
   - What happens: `listen()` deletes a message, then runs the handler. A crash or SIGKILL during the handler loses the delivery or the inbound activity. Retries are re-enqueued only after the handler fails.
   - Repro: enqueue a task whose handler sleeps; kill the process; the row is gone.
   - Ask: a visibility timeout or lease, deleting on success.
6. **Outgoing normalisation not exported.** `normalizeOutgoingActivityJsonLd` (CURIE `as:Public` to the full IRI, one-element `attachment` to an array) runs inside `sendActivity` only. Applications that deliver JSON themselves need it.
7. **`allowPrivateAddress` is all-or-nothing.** A lab or private deployment needs an allowlist of ranges rather than switching the guard off. Fedify also lists 192.88.99.0/24, which Python and Rust treat as global.
8. **Smaller ones:**
   - one actor dispatcher per Federation (issue 646);
   - `startQueue()` resolves only when the queue stops, which deserves a line in its documentation;
   - `signRequest` refuses a non-extractable private key.

### Remaining work and live-peer risks

1. **Lemmy first-contact skip** (live-peer risk, unchanged). Lemmy's outbound worker for a new instance skips activities queued before it started. The first Follow from a Lemmy instance that has never seen the domain can be lost. Measure it in slice 3.
2. **PieFed day-one cap** (live-peer risk, unchanged). PieFed refuses a remote account's fifth post in its first 24 hours, even in Feddit's communities. Measure it with brand-new accounts in slice 3.
3. **PieFed defects to report upstream:**
   - the unban task crash;
   - API bans limited to local communities;
   - the moderator list cache not invalidated on a federated Add.
4. **Inbound processing is still at most once.** The inbound queue is Fedify's (`@fedify/postgres`), so a crash while an inbound activity is processed loses it. Senders do not retry, because Fedify already answered 202. The fix is the same lease pattern as the outbox, or a Fedify fix (upstream item 5).
5. **Not covered:** instance-wide bans (`Block` with an instance target), account deletion, `Update(Group)`, and moderation logs. Fetching remote moderator lists uses Fedify's document cache, so a newly added remote moderator may wait for the cache TTL.
6. **Slice 3 lab knobs to remove:**
   - `FEDDIT_ALLOW_PRIVATE_ADDRESS`
   - `FEDDIT_LAB_CIDR`
   - `LEMMY_TEST_FAST_FEDERATION`
   - the short outbox retries
   - PieFed backdating
   - the internal CA
   
   Then add Mbin, Lemmy 1.0 beta and a Mastodon account, plus media, mentions and private messages.

## Slice 1 details

### Interop matrix

Each scenario drives Lemmy's `/api/v3`, PieFed's `/api/alpha` and Feddit's `/spike/*` control surface. It passes only when the receiving side has stored the expected state, not merely when a delivery got a 2xx. Results are in `captures/results.json`.

| ID | What happens | Wire activities | Lemmy | PieFed |
|---|---|---|---|---|
| S1 | Peer user follows `!spike@feddit.lab.test` | Follow, then Accept with the Follow embedded | pass | pass |
| S2 | Feddit text post in !spike reaches the peer: title, markdown source and author match | Announce(Create(Page)) | pass | pass |
| S3 | Peer user comments on it; Feddit stores the Note with the right inReplyTo | Create(Note) to the Group | pass | pass |
| S4 | Peer upvotes the post and downvotes a Feddit comment, then retracts both | Like, Dislike, Undo(Like), Undo(Dislike) | pass | pass |
| S5 | Feddit reply to the peer's comment threads under it | Announce(Create(Note)) | pass | pass |
| S6 | Feddit edits the post title and body | Announce(Update(Page)) | pass | pass |
| S7 | Feddit deletes its reply; the object URL then serves a 410 Tombstone | Announce(Delete) | pass | pass |
| S8 | Peer user posts into !spike; Feddit stores it and relays it to the other peer | Create(Page), then Announce(Create(Page)) wrapping the original JSON | pass | pass |
| S8b | That peer edits, then deletes, the post; Feddit applies both and relays them | Update(Page) and Delete, then Announce of each | pass | pass |
| S9 | Feddit link post; the peer shows the URL | Page with `attachment: [Link]` | pass | pass |
| R1 | Feddit user follows the peer's community | Follow, then an Accept matched to this follower and this Follow id | pass | pass |
| R2 | Native post and comment on the peer reach Feddit | Announce(Create(Page)), Announce(Create(Note)) | pass | pass |
| R3 | Feddit user comments in the peer's community, then likes and un-likes the post; the score moves 1 to 2 to 1 | Create(Note), Like, Undo(Like) to the remote Group | pass | pass |
| R4 | Peer edits the post and deletes the comment; Feddit applies both | Announce(Update(Page)), Announce(Delete) | pass | pass |
| R5 | Feddit edits, then deletes, its comment in the peer's community | Update(Note), Delete to the remote Group | pass | pass |
| R6 | Feddit creates, edits, then deletes a Page in the peer's community; author, title and body match on the peer | Create(Page), Update(Page), Delete to the remote Group | pass | pass |

How the scenarios cover each gate verb:

| Gate verb | Feddit to peer | Peer to Feddit |
|---|---|---|
| Follow | S1 | R1 |
| Post | S2, S9, R6 | R2, S8 |
| Comment | S5, R3 | S3, R2 |
| Vote and undo | R3 | S4 |
| Edit | S6, R5, R6 | S8b, R4 |
| Delete | S7, R5, R6 | S8b, R4 |
| Relay | S8 and S8b (Lemmy to PieFed and back) | |

Not covered:

- images and media upload
- mentions and notifications
- private messages
- language tags and NSFW
- peers editing comments, rather than posts, in Feddit's community
- relayed votes asserted on the other peer. Feddit does send Announce(Like) and Announce(Dislike); see the captures.

### Actor URL decision

Decision:

- **Actor ids.** One actor template, `/ap/{identifier}`, with the kind in the identifier: `https://feddit.lab.test/ap/u.alice` (Person) and `https://feddit.lab.test/ap/c.spike` (Group).
- **Human URLs.** Each actor's `url` is `/u/alice` or `/c/spike`. Those pages also answer `Accept: application/activity+json` with the actor document directly, without a redirect, because PieFed's fetcher does not follow redirects.
- **WebFinger.** `acct:name@host` maps to the Person first. When a Group shares the name, it is added as a second `self` link with `properties["https://www.w3.org/ns/activitystreams#type"] = "Group"`.
- **Instance actor.** It sits at `/` (slice 2).

Why:

- Fedify allows one actor dispatcher per Federation (issue 646).
- The alternative is two Federation instances, one for users and one for communities. It was rejected because each instance would own its own:
  - shared inbox
  - WebFinger and NodeInfo routes
  - KV and queue prefixes and queue workers
  
  Also, `ctx.parseUri` in one instance would not recognise the other instance's actors.

Collision and instance checks (`make collision`, `captures/collision-results.json`):

| ID | Check | Lemmy | PieFed |
|---|---|---|---|
| C0 | WebFinger for a shared name lists the Person, then the Group | pass | pass |
| C1 | `!name@feddit.lab.test` resolves to the community | `known`: resolves the Person | pass |
| C2 | `@name@feddit.lab.test` resolves to the person | pass | pass |
| C3 | Pasting `https://feddit.lab.test/c/name` resolves to the community | pass | pass |
| I1 | `/` serves the Application actor: key, shared inbox, name equal to NodeInfo 2.0 and 2.1 `nodeName` | pass | |

WebFinger cannot tell `!name` from `@name`, because both arrive as `acct:name@host`. For either prefix, Lemmy 0.19.21 dereferences the first `self` link that parses. Putting the Group first would break `@name` instead.

Recommendation for the product:

- Treat user and community names as one namespace: reject a community name that is an existing username, and the reverse.
- Keep the kind prefix in actor ids anyway. It is cheap, keeps `parseUri` unambiguous and needs no migration if collisions are ever allowed.

### Workarounds and their time cost

Slice 1 took about 5 hours, of which about 2.75 went to the items below. "Lab" means the item stays in the lab. "Product" means Feddit needs the same thing in production.

| # | Workaround | Where | Why | Time |
|---|---|---|---|---|
| 1 | Caddy `tls internal` for every host, with its root CA copied by a one-shot `lab-ca` service into a world-readable volume; trusted through `SSL_CERT_FILE` (Lemmy), `REQUESTS_CA_BUNDLE` (PieFed) and `NODE_EXTRA_CA_CERTS` (Node) | lab | Lemmy and PieFed build `https://` URLs. Lemmy could not read Caddy's 0700 pki directory | 25 min |
| 2 | Lab subnet 192.88.99.0/24 | lab | Lemmy and PieFed accept it with their production SSRF checks on, because Python and Rust classify the retired 6to4 prefix (RFC 7526) as global. No flag is involved. Fedify classifies it as non-public, so Feddit alone sets `FEDDIT_ALLOW_PRIVATE_ADDRESS=1`. Fedify also cached the failed key fetch, so the KV table had to be truncated once | 15 min |
| 3 | PieFed entrypoint without `flask populate_community_search` | lab | That step downloads from data.lemmyverse.net and crash-loops without egress | 5 min |
| 4 | PieFed allowlist also lists `piefed.lab.test` itself | lab | `validate_remote_actor` applies the allowlist to PieFed's own actors, so Follows of its own communities failed with "Could not find target of Follow" | 15 min |
| 5 | Fresh author and follower per run, and `make scenarios` backdates PieFed's remote users by 2 days | lab | PieFed lets a remote account it first saw under 24 h ago make only 4 posts (`can_create_post`, hard-coded), including posts in communities hosted elsewhere. PieFed also sends no Accept for a repeat Follow from an existing member | 15 min |
| 6 | `make seed` waits until Lemmy has outbound workers for both lab peers | lab | Lemmy release builds start a worker for a newly seen instance on a 60 s timer, and the worker skips everything queued before it started. The first Follow from Lemmy was silently lost | 15 min |
| 7 | Seed reuses the JWT from Lemmy's register call | lab | Logging in again within the same second collides on `login_token_pkey`, because JWT `iat` has one-second resolution | 5 min |
| 8 | A community relays a remote activity by wrapping the original JSON in a plain Announce | product | Fedify's `sendActivity` re-serialises with JSON-LD compaction. That collapsed one-element arrays (`tag`, `to`) and dropped terms PieFed's context does not define (`language`, `distinguished`, `flair`). Lemmy rejected the result with "data did not match any variant of untagged enum AnnouncableActivities". In slice 1 relays bypassed Fedify's queue with in-process retries; slice 2 moved them to the durable outbox | 30 min |
| 9 | Served Group JSON gets a Lemmy context plus `postingRestrictedToMods` and `moderators`; the moderators collection is flattened to IRIs; request URLs are rebased on the canonical origin | product | Fedify's vocabulary has no Lemmy terms, Fedify embeds whole Person objects in the collection, and behind Caddy the collection ids came out as `http://` | 10 min |
| 10 | `federation.startQueue()` is not awaited | product | The promise runs the worker loop and never resolves, so awaiting it kept the HTTP server from starting | 5 min |
| 11 | Lock and Undo(Lock) are built as raw JSON | product | Fedify has no Lock type | in 8 |
| 12 | Moderation scenarios add the peer admin as a second follower of !spike | lab | A Lemmy community ban unsubscribes the user. Lemmy then rejects a community's Announces when no local user follows it (`community_has_no_followers`), so the unban of a sole follower is lost | 10 min |
| 13 | Skip our own activities in Announces before fetching anything | product | Lemmy relays a member's own activities back to the member's server. Fedify re-fetches a cross-origin embedded object from its origin, and Feddit does not serve activity ids, so the listener threw and the queue retried each echo 7 times. Slice 2 replaced this with origin and id de-duplication | 10 min |

### Defects and protocol surprises

Capture paths are relative to `captures/`.

#### Fedify 2.4.5

See also the upstream list above.

1. **Re-serialisation is lossy for relays.** See workaround 8.
   - The original PieFed Create is at `session-1-debugging/inbound.jsonl` line 22.
   - Fedify's compacted relay of it is at `session-1-debugging/outbound.jsonl` line 18.
2. **Double knock and retries of permanent errors** (upstream items 1 and 2). One activity was sent 20 times over 12 minutes (`session-1-debugging/outbound.jsonl` lines 18 to 122). Feddit's outbox now sends a single cavage-signed request per attempt and stops on permanent errors (D3, D3b).
3. **SSRF guard and negative cache.** Fedify classifies 192.88.99.0/24 as non-public, so Lemmy's first Follows got 401. The failure stayed cached in `fedify_kv_v2` until the table was truncated (`session-1-debugging/inbound.jsonl` lines 1 and 2).
4. **No Lock type** (upstream item 3). Handled from raw JSON in slice 2 (M2, P2, N3).
5. **No Lemmy or PieFed vocabulary** (upstream item 4).
6. **Collections embed objects.** `setOrderedCollectionDispatcher` embeds whole objects, while Lemmy expects IRIs (workaround 9).
7. **Echo retries.** Before workaround 13, Lemmy's echoes produced 117 ERROR log records (`session-4-echo-retries/fedify.jsonl.gz`).

#### Lemmy 0.19.21

1. **First-contact skip.**
   - What happens: a release build starts the outbound worker for a newly seen instance within 60 s, and that worker skips every activity queued before it started (workaround 6).
   - Live risk: the first Follow from a Lemmy instance that has never talked to Feddit can be lost, and the user sees "Pending" until they resubscribe.
2. **`community_has_no_followers`.**
   - What happens: Lemmy rejects a community's Announce when no local user follows the community (workaround 12).
   - Evidence: `session-2-relay-and-moderation/outbound.jsonl` lines 81 and 92.
3. **Strict serde, opaque errors.** The untagged-enum error does not say which field failed. Lemmy requires `cc` on Create and Update, the full Public IRI in addressing (it answers `object_is_not_public` to `as:Public`), and `attachment` as an array.
4. **`!name` resolves to the first WebFinger link** (C1).
5. **Echoes.** Lemmy relays a remote member's own activities back to that member's instance. PieFed leaves the origin instance out.
6. **Ban delivery.** Lemmy sends a community ban both direct (Block) and announced. PieFed only announces it.
7. **Moderator check by domain.**
   - What happens: `verify_mod_action` accepts a mod action from any actor on the community's own domain without consulting the `moderators` list.
   - Effect: Feddit's mod actions in its own communities pass this way, so Feddit alone authorises its moderators. Remote moderators of a Feddit community are checked against the list Feddit federates (P0 to P5).
8. **Instance actor.** Lemmy fetches `/` for an instance actor. Feddit serves one since slice 2.

#### PieFed 1.8.11

1. **Allowlist covers PieFed's own domain** (workaround 4).
2. **Day-one post cap for remote accounts** (workaround 5).
   - Live risk: a brand-new Feddit user who makes a fifth post on their first day, even in a Feddit community, is refused by every PieFed follower of that community.
3. **No Accept on a repeat Follow** from an existing member.
4. **API unban crashes.**
   - What happens: the Celery task `unban_from_community` raises `AttributeError: 'str' object has no attribute 'isoformat'`. `ap_datetime(expiry)` receives a string, at `app/shared/tasks/blocks.py` line 125.
   - Evidence: `piefed-celery-unban-error.log`; M4 is `known`.
   - Not tested: the web UI unban path.
5. **API bans only in local communities:** "Community not local to this instance" (P4).
6. **Moderator list cache.** A federated Add updates `community_member` but not the API's `cached_modlist_for_community` (P0).
7. **Optimistic subscription.** The follow API reports "Subscribed" before the Accept arrives.
8. **Minimal JSON-LD context.** With `FULL_AP_CONTEXT=0`, PieFed's context leaves `language`, `flair`, `distinguished` and even `featured` undefined. A JSON-LD processor such as Fedify cannot see them, so Feddit reads `featured` from the raw Group document.
9. **Slug post ids.** PieFed's post `ap_id`s are slug URLs such as `/c/spike@feddit.lab.test/p/16/s8-from-piefed-...`. Feddit treats ids as opaque, so nothing breaks.
10. **Celery health check.** The image's HEALTHCHECK runs in the worker container too, where it fails. That was a lab configuration issue, fixed with upstream's `celery inspect ping`.

## Lab resource usage

Idle memory after the final run (`make stats`):

| Container | Memory |
|---|---|
| piefed-celery | 536 MiB |
| piefed-web | 452 MiB |
| piefed-db | 108 MiB |
| lemmy-db | 85 MiB |
| feddit (fresh after the SIGKILL test) | 82 MiB |
| rogue | 82 MiB |
| lemmy-ui | 80 MiB |
| feddit-db | 57 MiB |
| lemmy | 51 MiB |
| lemmy-pictrs | 28 MiB |
| caddy | 23 MiB |
| piefed-redis | 11 MiB |
| Total | about 1.6 GiB |

PieFed's two processes use more than half of it. The rogue peer is test-only.

Disk use:

| Item | Size |
|---|---|
| Images: lemmy-ui | 1.1 GB |
| Images: piefed (local build) | 1.08 GB |
| Images: postgres:17 | 667 MB |
| Images: feddit-spike (also used by runner, rogue and host-ports) | 547 MB |
| Images: postgres:16-alpine | 411 MB |
| Images: pictrs | 297 MB |
| Images: lemmy | 276 MB |
| Images: caddy | 80 MB |
| Images: redis | 59 MB |
| Volumes after one full run: lemmy-db, piefed-db, feddit-db | 50 to 80 MB each |
| Volumes after one full run: everything else | under 1 MB |

## Files

- `src/`: the Fedify app.
  - `federation.ts`: actors, collections, WebFinger and NodeInfo
  - `inbox.ts`: inbound trust, de-duplication and every handler
  - `authz.ts`: rights, origin rules, moderator lists and bans
  - `outbox.ts`: durable delivery and the retry policy
  - `safe-post.ts`: the guarded HTTPS POST
  - `relay.ts`: FEP-1b12 Announces
  - `instance.ts`: the instance actor
  - `actions.ts`: outbound verbs and moderation
  - `content.ts`: Page and Note mapping
  - `routes.ts`: Hono app with the `/spike/*` control surface, the NodeInfo discovery documents, the Lemmy Group patch, the instance actor route and the human pages
  - `capture.ts` and `logging.ts`: raw captures and the LogTape file sink
  - `db.ts`: Postgres schema and queries
- `scenarios/`:
  - `seed.ts`
  - `run.ts`: S and R scenarios
  - `moderation.ts`: S10-S14, M, P
  - `authz.ts`: N
  - `durability.ts`: D
  - `collision.ts`: C and I
  - `rogue.ts`: the rogue lab peer
  - `lib.ts`: peer API clients and the result recorder
  - `get.ts`: debug fetch
- `captures/`: the final clean run. Captures are appended to, so `make reset` does not clear them.
  - `inbound.jsonl`: every POST to an inbox, with headers and status
  - `outbound.jsonl`: every delivery attempt, with the peer's answer
  - `fetched.jsonl`: every GET Feddit made
  - `rejected.jsonl`: every refusal, with the raw activity
  - `fedify.jsonl`: the LogTape log
  - the peers' own records: `lemmy-sent_activity.jsonl`, `piefed-activity_pub_log.jsonl`, `lemmy-instance-feddit.json` and `piefed-instance-feddit.json`
  - the results JSON files, `moderation/` and `authz/`
  - archives:
    - `session-1-debugging/`: lossy relay, double knock, SSRF 401s
    - `session-2-relay-and-moderation/`: `community_has_no_followers`
    - `session-3-clean-run-and-reruns/`: the first clean run plus reruns while adding S8b and R5
    - `session-4-echo-retries/`: a clean run before workaround 13
    - `session-5-slice2-development/`: slice-2 development runs
    
    Fedify logs in the archives are gzipped.
- `../../lab/`: the Compose lab; see `lab/README.md`.

## Follow-up review notes (independent static review, 2026-11-08)

Verdict: the original Announce impersonation path is closed and every reported count reproduces from the captures (32 interop, 38 moderation plus 1 known and 1 not applicable, 16 authorization including the N0 control, 11 delivery, 7 collision plus 1 known; 194 recorded outbound outcomes with 155 2xx; 125 inbound with 124 accepted; 41 of 41 relays structurally identical). The durable outbox, centralized authorization, preservation of third-party JSON and the root instance actor are justified directions. The implementation in this spike is not yet a product reference; the items below carry forward as requirements for the real server.

Prior findings: P1.1 fixed for the original exploit (regression coverage incomplete, see item 8); P1.2 partially fixed (item 2); P1.3 fixed in the default configuration; P2.4, P2.5, P2.6 and P2.7 fixed.

New findings, most severe first:

1. P1. Positive moderator-cache entries never expire (`src/authz.ts` around line 96 returns a cached grant before checking age); a removed moderator keeps authority until an Add or Remove arrives. Requirement: bound positive entries by time and refetch the moderator collection.
2. P1. The SSRF guard's IPv6 exclusions are incomplete (`src/safe-post.ts` around line 26 accepts `fec0::/10` site-local, `64:ff9b:1::/48` local-use NAT64 and `2002::/16` 6to4). Requirement: reuse a complete public-address predicate, including the IPv4-mapped and transition ranges, and test them.
3. P2. A signed Reject deletes a subscription by Follow id without matching the Reject actor to the followed actor (`src/inbox.ts` around line 565); any actor that knows a Follow id can cancel it. Requirement: match actor and follow row as Accept does.
4. P2. Crash consistency: the dedupe marker is committed before the activity is applied (`src/inbox.ts` around line 134), so a crash leaves a permanent "already applied" marker; local state and outbound enqueueing commit separately (`src/actions.ts` around lines 159 and 177). Requirement: apply, enqueue and mark in one transaction (the transactional outbox pattern from the July plan).
5. P2. Cross-origin relay verification refetches activity ids that Feddit itself never serves (`/ap/activities/...` has no dispatcher), so a second Feddit receiver could not verify a Feddit-authored activity relayed by a third-party community. Requirement: serve activity documents or embed verifiable objects.
6. P2. Hosting-instance administrators are not recognised as authorities; Lemmy admins moderate communities without appearing in moderator collections, so their valid Announces would be refused. Requirement: accept the owning community's Announce as authority for moderation, or model instance admins.
7. P2. Local authors can comment on locked posts (`src/actions.ts` around line 181 checks bans but not `locked`); the inbound path does check.
8. P2. N10, N7 and N2 accept any rejection reason, so they would stay green if their named check were removed; N11 and N12 are stronger. Requirement: assert the specific refusal reason.
9. P2. PieFed P5 passed in 0 seconds because P0 had already shown the stale moderator list; it does not prove revocation.
10. P2. The "known defect" classification labels any exception as known when a description is supplied (`scenarios/lib.ts` around line 104), which can mask unrelated failures in M4 and C1.
11. P3. Numeric corrections: the production retry schedule sums to about 15 hours, not 11; delivery attempts were at least 195 (the SIGKILL-interrupted POST has no record), while the 155 recorded 2xx stands; "16 of 16 authorization cases" means one control plus fifteen refusals.

Not verified statically by the reviewer: runtime network isolation, DNS-rebinding behaviour under changing DNS, TLS failure handling, multi-worker lease safety, third-origin relay refetch, admin actions outside moderator lists, revocation after a missed Remove, direct author deliveries claiming a foreign community (accepted without a hosting-community Announce; policy undefined), instance-key continuity across restart, and live-peer behaviour.
