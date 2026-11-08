# Slice 3: the live lab

The Fedify spike, deployed unchanged as `https://lab.feddit.com`, federating with the real PieFed 1.8.11 at `https://feddit.com`. A runner on a laptop drives both sides: `scenarios/live.ts`.

Posts go only into communities we control: `!lab@lab.feddit.com`, and one existing local community on the PieFed instance. L10 follows communities on other instances and never posts, comments or votes there.

## Deploy shape

The image is `Dockerfile` in this directory (`node:24-bookworm-slim`, runs `node src/main.ts`, listens on `PORT`). Behind Easypanel's Traefik, which terminates TLS and forwards plain HTTP with the Host header intact.

| Variable | Value | Notes |
|---|---|---|
| `FEDDIT_ORIGIN` | `https://lab.feddit.com` | Canonical origin; every URL and actor id derives from it |
| `PORT` | `8000` | |
| `DATABASE_URL` | `postgres://...` | Own Postgres; the app creates its tables and Fedify's |
| `FEDDIT_CONTROL_TOKEN` | long random string | Required on the internet. Every `/spike/*` request must send `Authorization: Bearer <token>`, otherwise 401. Unset in the local lab only |
| `FEDDIT_NODE_NAME` | `peblish federation lab` | NodeInfo `nodeName` and the instance actor's name (default `Feddit spike (lab)`) |
| `CAPTURE_DIR` | `/app/captures` | Raw inbound, outbound, fetched and rejected JSON lines. Mount a volume to keep them |

Leave these unset: `FEDDIT_ALLOW_PRIVATE_ADDRESS`, `FEDDIT_LAB_CIDR`, `FEDDIT_OUTBOX_*` (the defaults retry for hours, as production would).

The unauthenticated surface is the federation itself: `/.well-known/*`, `/nodeinfo/*`, `/ap/*`, `/inbox`, `/c/*`, `/u/*`, `/`, `/link-target`.

## Run

Put the runner's variables in `~/.agents/feddit-lab.env`, then:

```sh
cd spikes/fedify-threadiverse
set -a; . ~/.agents/feddit-lab.env; set +a
node scenarios/live.ts
```

Needs Node 24 (the repo's `engines`) and `npm ci` once. `node scenarios/live.ts --help` prints the usage and touches nothing.

### Runner environment

| Variable | Required | Meaning |
|---|---|---|
| `LIVE_LAB_ORIGIN` | yes | `https://lab.feddit.com` |
| `LIVE_CONTROL_TOKEN` | yes | The lab's `FEDDIT_CONTROL_TOKEN` |
| `LIVE_PIEFED_ORIGIN` | yes | `https://feddit.com` |
| `LIVE_PIEFED_USER` | yes | Non-admin PieFed test account (`peblish_test`) |
| `LIVE_PIEFED_PASSWORD` | yes | Its password |
| `LIVE_PIEFED_COMMUNITY` | yes | Name of an existing local PieFed community (never created) |
| `LIVE_TIMEOUT_MS` | no | Per wait, default `180000`. PieFed delivers through Celery and can take a minute |
| `LIVE_FOLLOW_ONLY` | no | Comma-separated `!name@host` communities on other instances, for L10. Unset: L10 is `n/a` |
| `LIVE_FOLLOW_OBSERVE_MS` | no | L10 observation window after the Accept, default `120000` (`0` skips it) |

A missing required variable stops the run before any request.

### Flags

| Flag | Effect |
|---|---|
| `--only=L1,L3` | Run only these. Later scenarios need the ids of earlier ones, so combine with `--run` |
| `--run=<id>` | Reuse a previous run's names and ids (`captures/live-<id>-ids.json`). Re-running a scenario that creates content creates new content and replaces its ids |
| `--keep` | Skip the automatic cleanup (L9) after a full run |
| `--cleanup` | Run only L9 for `--run=<id>` |
| `--help` | Usage |

## Scenarios

Each one asserts on PieFed's API and on the lab's `/spike/state`. Titles are `[peblish lab test <run>] ...`. The lab author is `t<run>`, the moderator `labmod`; both and the `lab` community (displayName `peblish federation lab`, moderated by `labmod`) are created on first use.

| ID | What happens | Passes when |
|---|---|---|
| L1 discover | PieFed resolves `!lab@lab.feddit.com` | PieFed returns a community id |
| L2 follow | The test account follows the lab community | The lab stores the follower, PieFed shows Subscribed, the lab's Accept was delivered |
| L3 lab to PieFed | The lab author posts a text post and a link post (`<lab>/link-target?run=<run>`) | PieFed lists both with title, markdown body, author and url; the lab's delivery was answered 2xx |
| L4 PieFed to lab | The test account posts in the lab community and comments on the L3 text post | The lab stores both (author, community, inReplyTo); PieFed shows each once |
| L5 votes | The test account upvotes the L3 text post, then undoes it | The lab stores the Like, then drops it; PieFed's score moves up one and back |
| L6 edit, delete | The lab edits the text post and deletes the link post | PieFed shows the new title and body, and hides the link post |
| L7 moderation | `labmod` locks, unlocks, removes (with a reason) and restores the L4 comment | PieFed shows each state |
| L8 reverse | The lab author follows `!<community>@<PieFed host>`, posts in it; the test account comments | PieFed lists the lab post; the lab stores the comment (arrives as an Announce) |
| L9 cleanup | See below | Every check passes |
| L10 follow only | The lab author follows each `LIVE_FOLLOW_ONLY` community and the lab watches `inbox_log` | The Accept arrives. The note counts inbound activities from that host and lists their types; zero is a pass |

The run ends with the scenario statuses and the remote followers in `/spike/state.followers`, so a Mastodon follow by the owner shows up there.

Results go to `captures/live-<run>.json` (`live-<run>-cleanup.json` for `--cleanup`). `captures/live-<run>-ids.json` lists everything created: lab actor names and URIs, lab post URIs, PieFed community, post and comment ids, followed communities.

PieFed refuses a remote account's fifth post in its first 24 hours. A run makes three posts per lab author, so it stays under the cap, and each run uses a new author.

## Cleanup and teardown

L9 runs after a full run unless `--keep` is given, and on its own with `--cleanup --run=<id>`. It tolerates partial state, using the ids file. In order:

1. The test account deletes its L8 comment on PieFed.
2. The lab deletes the L8 post (Delete to the PieFed community); PieFed must hide it.
3. The test account deletes the L4 comment and post on PieFed; the lab must mark them deleted.
4. The test account unfollows the lab community; the lab must drop the follower.
5. The lab author unfollows every community it followed (L8, L10) with `Undo(Follow)`, through `POST /spike/unfollow`.

The L3 posts and the `lab` community stay, so there is something to look at. Never touched: any content or community not in the ids file.

Full teardown, in this order:

1. `node scenarios/live.ts --cleanup --run=<id>` for each run.
2. Check `/spike/state.followers` and `.following` are empty of test accounts.
3. Stop and delete the Easypanel app, then its database.
4. Remove the `peblish_test` account and its subscriptions on PieFed.
