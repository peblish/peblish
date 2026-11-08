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
| `--run=<id>` | Reuse a previous run's names and ids (`captures/live-<id>-ids.json`). The ids file records the lab, PieFed origin, test account and community it was made for, and `--run` and `--cleanup` refuse any other deployment. A rerun reuses content the lab or PieFed still has instead of creating it again |
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
| L7 moderation | `labmod` locks and unlocks the L3 text post, then removes (with a reason) and restores the L4 comment | PieFed shows each state |
| L8 reverse | The lab author follows `!<community>@<PieFed host>`, posts in it; the test account comments | PieFed lists the lab post; the lab stores the comment (arrives as an Announce) |
| L9 cleanup | See below | Every check passes |
| L10 follow only | The lab author follows each `LIVE_FOLLOW_ONLY` community and the lab watches `inbox_log` | The Accept arrives. The note counts inbound activities from that host and lists their types; zero is a pass |

The run ends with the scenario statuses and the remote followers in `/spike/state.followers`, so a Mastodon follow by the owner shows up there.

### Mastodon

A Mastodon account follows the group as `@lab@lab.feddit.com` (or the moderator as `@labmod@lab.feddit.com`) and the follower appears in `/spike/state.followers`. Mastodon shows nothing from the group's normal `Announce(Create(Page))` fan-out: it only turns an `Announce` whose object is the post itself into a boost, the second copy Lemmy sends to every follower and rejects on receipt (`CannotReceivePage`). To make one post visible there, send that shape to the followers at the named origins only:

```sh
curl -sS -X POST "$LIVE_LAB_ORIGIN/spike/announce-page" \
  -H "Authorization: Bearer $LIVE_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"object":"https://lab.feddit.com/ap/post/15","origins":["https://mastodon.social"]}'
```

`object` is a local post URI and `origins` lists follower origins; followers elsewhere get nothing. Check with Mastodon's public API: `GET https://mastodon.social/api/v1/accounts/lookup?acct=lab@lab.feddit.com`, then `/api/v1/accounts/<id>/statuses`, where the post appears as a boost by the group. A reply from Mastodon should reach the author's inbox as `Create(Note)` with `inReplyTo` set and show up in `/spike/state` (inbox log and objects).

Results go to `captures/live-<run>.json` (`live-<run>-cleanup.json` for `--cleanup`). `captures/live-<run>-ids.json` lists everything created: lab actor names and URIs, lab post URIs, PieFed community, post and comment ids, followed communities, the post count and the L7 lock and removal flags. `captures/live-<run>-state.json` (`-cleanup-state.json` for `--cleanup`) is the lab's whole `/spike/state` at the end of the run: outbox rows, followers, votes and the inbox log, as evidence for the delivery and unfollow claims.

PieFed lets a remote account it first saw in the last 24 hours make 4 posts. A run makes three posts per lab author (two in L3, one in L8) and refuses to create a fourth, counting from the ids file and from what the lab holds. Each run uses a new author.

## Cleanup and teardown

L9 runs after a full run unless `--keep` is given, and on its own with `--cleanup --run=<id>`. It works from the ids file, so it tolerates a run that stopped half way, and it fails unless the end state is clean. In order:

1. Reverse what L7 left: unlock the L3 text post and restore the L4 comment if the ids or the lab say they are still locked or removed.
2. Undo any vote the test account still has on the run's objects.
3. The test account deletes its L8 comment on PieFed; the lab deletes the L8 post (Delete to the PieFed community).
4. The test account deletes the L4 comment and post on PieFed.
5. The test account unfollows the lab community; the lab author unfollows every community it follows (`Undo(Follow)` through `POST /spike/unfollow`).

Before it deletes anything, it fetches the object and refuses unless the creator is the test account or the lab author and the title (or comment body) starts with `[peblish lab test <run>]`; on the lab it also requires the object to be local. A step that fails counts as a failure unless there was nothing left to undo.

Final checks, all of which must hold: the lab marks each deleted object deleted and PieFed hides the L8 post; the lab holds no follower row for the test account and no `following` row for the lab author, and each `Undo(Follow)` reached `delivered` in the lab's outbox; the test account has no votes on the run's objects; the L3 text post is unlocked and the L4 comment is not removed.

The L3 posts and the `lab` community stay, so there is something to look at.

Full teardown, in this order:

1. `node scenarios/live.ts --cleanup --run=<id>` for each run. An ids file made before the env block existed is refused; add the block by hand if you are sure it belongs to this deployment.
2. Check `/spike/state.followers` and `.following` are empty of test accounts.
3. Stop and delete the Easypanel app, then its database.
4. Remove the `peblish_test` account and its subscriptions on PieFed.

## Tests

`npm test` runs the unit tests (delivery guard, inbox body limit, capture limits). `test/following.test.ts` also needs a throwaway Postgres and is skipped without it: `TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db npm test`.
