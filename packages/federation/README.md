# @peblish/federation

Everything ActivityPub. This is the only package that imports `@fedify/*` (lint rule
`fedify-only-in-federation`), and what it takes from Fedify is small on purpose.

## What Fedify does here, and what it does not

Fedify signs our outgoing requests (`signRequest` in `src/signing/sign.ts`) and its
`verifyRequest` is what the tests check our signatures against. Nothing else of it runs:

- **No dispatchers.** It compacts the JSON-LD it serves, and Lemmy's strict parser rejects the
  result. Every document we serve or send is built by the mapping (`src/mapping/`, `toWire`).
- **No router.** It takes one actor path template (issue 646), and we serve `/ap/u.<name>`,
  `/ap/c.<name>` and the imported `/u/<name>`, `/c/<name>`. `src/http.ts` routes.
- **No queue.** A message that crashes a worker mid-delivery is lost, and its retry signs a
  second time with another scheme and hides the first error. The delivery queue is a table.
- **No key-value store.** Nothing is left to keep in one (dedupe is `inbox_dedupe`, the queue
  is `deliveries`, remote actors are `actors`), so `federation.ts` holds only the software
  identity and the local origin.

## Layout

| Directory       | What it holds                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `mapping/`      | Pure wire to record functions, the Lemmy dialect (`mapping/README.md`)                          |
| `signing/`      | draft-cavage-12 signing for deliveries, signature checks for the inbox                          |
| `actors/`       | Fetching remote actors (`resolve.ts`), the documents we serve (`serve.ts`), the B2 seam         |
| `webfinger/`    | The WebFinger client and endpoint                                                               |
| `nodeinfo/`     | The NodeInfo client (software of a peer) and endpoint                                           |
| `delivery/`     | The outbound consumer, the queue, the worker, the Announce shapes                               |
| `inbound/`      | The inbox pipeline (lane FED-B); until it lands `receiveInbound` answers 503 with `Retry-After` |
| `http.ts`       | Routing, the only module web imports besides the consumer registry                              |
| `federation.ts` | Software name and version, the local origin, the User-Agent                                     |

## What we serve

`handleFederationRequest` answers these, read-only, from the database. Web's bridge sends
the paths in `federationPaths` before any UI route, and `/`, `/u/<name>`, `/c/<name>` only
when Accept prefers ActivityPub JSON (`Vary: Accept` on all of them, whoever answers). A
`null` answer from federation, such as a page path with no actor behind it, falls through to
the UI, which renders HTML.

| Path                                             | Document                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/`                                              | The instance actor (Application) named after the host                          |
| `/ap/u.<name>`, `/ap/c.<name>`                   | A new local Person or community, at its stored ap_id                           |
| `/u/<name>`, `/c/<name>`                         | The same actor by name; an imported actor's ap_id is this path                 |
| `<actor>/followers`                              | `Collection` with `totalItems` (accepted followers) and no people              |
| `<actor>/outbox`                                 | A community's live Create activities, 20 newest; empty for people and the site |
| `<community>/featured`, `<community>/moderators` | Pinned local posts as Pages; moderators, owners first                          |
| `/ap/post/<id>`, `/ap/comment/<id>`              | Page and Note; `410` with a Tombstone once deleted or removed                  |
| `/ap/activity/<id>`                              | An activity we sent, as stored                                                 |
| `/.well-known/webfinger`                         | `acct:<name>@<host>`, an actor URL or its page; Lemmy's link set               |
| `/.well-known/nodeinfo`, `/nodeinfo/2.0`, `2.1`  | Software `peblish`, `openRegistrations: false`, usage (cached a minute)        |
| `/inbox` and every actor's `/inbox`              | POST only, to `receiveInbound`                                                 |

An actor is served at the URLs its row advertises: a Person has no `featured`, and an
imported actor's collections sit below its `/u/<name>` id. A deleted local actor is still
served, scrubbed (peers learn of the deletion from the Delete). Nothing on an inbox, actor,
WebFinger or NodeInfo path answers 410, 418 or 500: an unexpected failure, a database outage
for one, is `503` with `Retry-After`, the answer peers retry.

## Signing

One signature per request, draft-cavage-http-signatures-12 with `rsa-sha256` (`hs2019` is
accepted inbound), over `(request-target) host date digest` with a SHA-256 `Digest`, using the
sender's key from `actor_keys`. On any 4xx we do not sign again another way. `verify.ts`
parses a request and checks it against a PEM (RSA of 2048 bits or more, a Date within an hour,
the digest of the body); `inbound.ts` finds the key (stored, or fetched once a minute when
unknown or failing) and returns the key's owner or a typed failure. A local actor's key is
never accepted for an inbound request.

## Remote actors and every outbound fetch

`resolveRemoteActor` takes an ap_id or a handle (`@name@host`, `!name@host`, found through
WebFinger), fetches the document, checks it (`checkRemoteActor`: one origin for the id, the
endpoints and the key, https, the owner is the actor) and stores it through `storeRemoteActor`
as the system principal `import`. The network is never touched inside a transaction, two
concurrent fetches store one actor, and a stale copy is returned when the peer is down.

Every request we make goes through `src/actors/safe-fetch.ts`, the seam to lane B2's
`@peblish/core/net/fetch`: https only, `maxRedirects: 0` on deliveries, a size and time cap,
no private address ever (there is no switch for one), and a `truncated` body is refused.

## Delivery

The consumer `federation.delivery` (`startAt: 'beginning'`) turns local outbox events into
activities: `post.*` to Create, Update, Delete and Undo(Delete) of a Page, `comment.*` to the
same of a Note, `vote.cast` to Like, Dislike or Undo, `follow.*` to Follow, Accept and
Undo(Follow), `actor.updated` to Update. It stores each in `activities` (served at its id) and
queues one `deliveries` row per (activity, inbox) with the body fixed at that moment. It sends
nothing for `local: false` events. A post or comment in a remote community goes to that
community's inbox; in a local community the community announces it.

**Announce shape.** Each follower inbox gets exactly one shape, chosen by the follower
instance's NodeInfo software (`delivery/software.ts`, lists as data):
`Announce(Create(Page))` (FEP-1b12) for Lemmy, PieFed, Mbin and unknown software, and
`Announce(Page)` for Mastodon-like software, only for a new post. Lemmy rejects
`Announce(Page)`, Mastodon drops the other. Shared inboxes are used first and deduplicated.

**The worker.** `federation.delivery_queue` runs every two seconds. A row is claimed with
`FOR UPDATE SKIP LOCKED` and a 60 second lease (the request times out at 15 seconds), the
activity is signed once, POSTed with no redirects and a 64 KiB response cap, and the outcome
recorded. A worker that dies leaves a lease that runs out and the row is sent again, so
delivery is at least once and receivers dedupe on the activity id.

| Answer                                                 | Result                              |
| ------------------------------------------------------ | ----------------------------------- |
| 2xx                                                    | delivered                           |
| 401, 408, 425, 429, 5xx, a timeout, a connection error | retried                             |
| any other 4xx, any 3xx, a refused destination          | failed, never retried               |
| an instance `isDormant` reports                        | skipped (lane REM fills the policy) |

Retries wait 10 s, 30 s, 90 s, 270 s, 810 s, 2,430 s, 7,290 s, then 6 hours twice (the
spike's schedule, in `delivery/policy.ts`): ten attempts over 54,130 seconds, about 15
hours. A `Retry-After` can lengthen a wait, up to 6 hours. A peer down longer misses the
activity. Before the first delivery to an instance, and once a day after, its NodeInfo is read
(`instances.software`).

## Follows

`packages/core/src/follows/` holds the service (`requestFollow`, `acceptFollow`,
`removeFollow`, `receiveFollow`) and `followState`, `followedCommunities` for the UI. A
follow of a remote community is pending until its Accept. The job `follows.retry` re-sends an
unanswered Follow with a fresh Follow id 5 and 15 minutes after the first, then leaves it
pending (lemmy.world accepted a second Follow about ten minutes after the first).

## For other lanes

- `verifyInboundSignature(request, body)` (`signing/inbound.ts`): the key's owner and key id,
  or a failure reason. The caller throttles requests that make it fetch an unknown key.
- `enqueueDeliveries(t, { activityApId, senderId, body, inboxes })` (`delivery/queue.ts`) in
  an open transaction; `followerInboxes(db, actorId, { skipOrigin })` groups inboxes by shape.
- `resolveRemoteActor`, `storeRemoteActor`, `deleteRemoteActor`, `ensureInstance`,
  `isDormant` (`packages/core/src/remote/`).
- `src/test/diff.ts` and the corpus tests (`delivery/corpus.test.ts`) compare what we send with
  what Lemmy and PieFed accepted.

## Inbound processing

Each inbound activity is stored in `inbox_raw` first, then one transaction (`tx` from
`@peblish/core/tx/tx`) writes its dedupe marker, applies it through a core mutation and
enqueues the resulting outbox events. Handlers live one per activity type in
`src/inbound/handlers/<type>.ts` (each exports `handler`), registered by glob.

Dedupe rule: the id passed to `Tx.dedupe` (stored in `inbox_dedupe`) is the id of the
activity being applied, which is the inner activity when it arrives inside an Announce.
A Create delivered directly by its author and the same Create relayed by the community's
Announce are therefore applied once.

## HTTP and consumers

`src/http.ts` is the HTTP seam. Web's server entry (`packages/web/src/server.ts`, through
`packages/web/src/server/federation.ts`) sends `isFederationRequest` matches to
`handleFederationRequest` before any UI route matches. Federation's outbox consumers live in
`src/<area>/consumer.ts` and its jobs in `src/<area>/job.ts`; the worker runs them beside
core's. Web may import only `@peblish/federation/http` and the consumer registry (lint rule
`web-federation-entry-points`).
