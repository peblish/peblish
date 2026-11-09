# @peblish/federation

Everything ActivityPub. This is the only package that imports `@fedify/*` (lint rule
`fedify-only-in-federation`), and no product code does: Fedify is a test oracle.

## What Fedify does here, and what it does not

Fedify runs in tests only (`src/signing/signing.test.ts`), as the independent implementation
our signing and verification are checked against: its verifier accepts what `sign.ts` signs
(deliveries and signed GETs), and our verifier accepts what its `signRequest` signs. Nothing of
it runs in the product:

- **Signing is ours.** Fedify's draft-cavage signer covers `url.pathname` for `(request-target)`,
  while peers (and our verifier) rebuild the target as path plus query, so a delivery to an
  inbox with a query string would never verify. `src/signing/sign.ts` signs the complete target.
- **Verification is ours, by decision.** `src/signing/verify.ts` and `inbound.ts` read the keys
  from `actor_keys`. Fedify's `verifyRequest` fetches the key and then its owner as JSON-LD
  documents, which would fetch a peer's `@context` on every check and go around our one
  document reader (`actors/document.ts` on `safeFetch`). It stays out, and so does anything
  else of Fedify's.
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

| Directory       | What it holds                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `mapping/`      | Pure wire to record functions, the Lemmy dialect (`mapping/README.md`)                                                                     |
| `signing/`      | draft-cavage-12 signing for deliveries and document fetches, signature checks for the inbox                                                |
| `actors/`       | Fetching remote actors (`resolve.ts`), the documents we serve (`serve.ts`), the B2 seam                                                    |
| `webfinger/`    | The WebFinger client and endpoint                                                                                                          |
| `nodeinfo/`     | The NodeInfo client (software of a peer) and endpoint                                                                                      |
| `delivery/`     | The outbound consumer, the queue, the worker, the Announce shapes                                                                          |
| `inbound/`      | The inbox: receipt, the pipeline, authorization, one handler per activity (lane FED-B)                                                     |
| `relay/`        | The community's Announce of what reached it, and the outbound moderation activities (FED-B)                                                |
| `backfill/`     | The queue (a consumer on follow.accepted) and the run (a job) of the backfill of a followed remote community; see `remote-fetch/README.md` |
| `remote-fetch/` | The cache figures, fetching a post, comment or actor on purpose, the missing-object job, politeness; see its `README.md`                   |
| `http.ts`       | Routing, the only module web imports besides the consumer registry                                                                         |
| `federation.ts` | Software name and version, the local origin, the User-Agent                                                                                |

## What we serve

`handleFederationRequest` answers these, read-only, from the database. Web's bridge sends
the paths in `federationPaths` before any UI route, and `/`, `/u/<name>`, `/c/<name>` only
when Accept prefers ActivityPub JSON (`Vary: Accept` on all of them, whoever answers). A
`null` answer from federation, such as a page path with no actor behind it, falls through to
the UI, which renders HTML.

| Path                                             | Document                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                              | The instance actor (Application) named after the host                                                                                                    |
| `/ap/u.<name>`, `/ap/c.<name>`                   | A new local Person or community, at its stored ap_id                                                                                                     |
| `/u/<name>`, `/c/<name>`                         | The same actor by name; an imported actor's ap_id is this path                                                                                           |
| `<actor>/followers`                              | `Collection` with `totalItems` (accepted followers) and no people                                                                                        |
| `<actor>/outbox`                                 | A community's live posts as Create activities rebuilt from their current state, 20 newest; empty for people, the site and a deleted or removed community |
| `<community>/featured`, `<community>/moderators` | Pinned local posts as Pages; fresh moderators, owners first                                                                                              |
| `/ap/post/<id>`, `/ap/comment/<id>`              | Page and Note; `410` with a Tombstone once not servable (below)                                                                                          |
| `/ap/activity/<id>`                              | An activity we sent, as stored; a Create, Update or Announce of content that is not servable is a `410` Tombstone                                        |
| `/.well-known/webfinger`                         | `acct:<name>@<host>`, an actor URL or its page; Lemmy's link set                                                                                         |
| `/.well-known/nodeinfo`, `/nodeinfo/2.0`, `2.1`  | Software `peblish`, `openRegistrations: false`, usage (cached a minute)                                                                                  |
| `/inbox` and every actor's `/inbox`              | POST only, to `receiveInbound`                                                                                                                           |

An actor is served at the URLs its row advertises: a Person has no `featured`, and an
imported actor's collections sit below its `/u/<name>` id. A deleted local actor is still
served, scrubbed (peers learn of the deletion from the Delete). Nothing on an inbox, actor,
WebFinger or NodeInfo path answers 410, 418 or 500: an unexpected failure, a database outage
for one, is `503` with `Retry-After`, the answer peers retry.

**Servable.** A post is served as a document only while it is live (not deleted, not removed)
and its community is neither deleted nor removed (a `community_removals` row); a comment also
needs its post to be live. Otherwise the id answers `410` with a Tombstone, and so do the
Create, Update and Announce activities that carried it, whatever shape (Announce(Create(Page)),
Announce(Page)). Delete, Undo, votes, follows and profile updates name content without
carrying it and stay served. `LoadedPost.servable` and `LoadedComment.servable`
(`delivery/records.ts`) say so; `live` is the publish path's, who asks only whether the thing
itself is still there. The outbox is rebuilt from the posts as they are now, so an edit shows
and nothing gone lingers.

A local activity can carry content someone else wrote: the community's Announce of a remote
Page or Note (`relay/announce.ts`) embeds it. The check for the activities (`heldContent`)
therefore reads any held post or comment whoever authored it, and an activity whose embedded
content is deleted, removed, on a gone post, in a deleted or removed community, or not held at
all answers the `410` Tombstone. The post and comment documents themselves are still served
only when they are ours: a remote object is not ours to serve.

## Signing

One signature per request, draft-cavage-http-signatures-12 with `rsa-sha256` (`hs2019` is
accepted inbound), using the sender's key from `actor_keys`, and never a second scheme after a
refusal. `sign.ts` signs ourselves (see above):

- **A delivery (POST)** covers six headers, `(request-target) accept content-type date digest host`
  (the set Lemmy and PieFed accepted in the lab), with a SHA-256 `Digest` of the body.
  `(request-target)` is the complete target, path and query string.
- **A document fetch (GET)** covers `(request-target) host date`, signed with the instance
  actor's key (`signing/instance.ts`), for peers that only answer authenticated fetches. Actor
  documents are fetched this way (`fetchActivity`); WebFinger and NodeInfo are public and are
  not signed. A redirected hop goes out unsigned (the signature vouches for one request). An
  instance with no usable key fetches unsigned.

`verify.ts` parses an inbox request and checks it against a PEM (the POST must cover
`(request-target) host date digest`; RSA of 2048 bits or more, a Date within an hour, the digest
of the body); `inbound.ts` finds the key (stored, or the actor fetched when the key is unknown
or fails) and returns the key's owner or a typed failure. An actor is fetched for its key at
most once a minute, successful or not, by an attempt log kept per process and bounded
(`refreshAttempts`, which holds a SHA-256 of the key id, since the sender chose the string),
because `fetched_at` only moves when a fetch works. A key id with no fragment whose document is
a key naming an `owner` on its own origin (GoToSocial's `actor/main-key`) is resolved through
that owner; the key itself is still taken from the owner's document. A local actor's key is
never accepted for an inbound request.

## Remote actors and every outbound fetch

`resolveRemoteActor` takes an ap_id or a handle (`@name@host`, `!name@host`, found through
WebFinger), fetches the document, checks it (`checkRemoteActor`: one origin for the id, the
endpoints and the key, https, the owner is the actor) and stores it through `storeRemoteActor`
as the system principal `import`. The network is never touched inside a transaction, two
concurrent fetches store one actor, and a stale copy is returned when the peer is down.

- The document must be the one asked for: its id is the requested id, or where it was finally
  served from after a redirect (fragments aside), on the origin it names. An actor document
  may be reached through up to three redirects, each hop its own request through the fetcher.
- A 200 `Tombstone` is the 410 answer when it names the requested id (or the address it was
  served from) on the requested actor's origin: the copy we hold is deleted with cause
  `Tombstone`, in ordinary resolution and in the inbound key refresh alike. A Tombstone for an
  actor we never held is refused (`gone`), and one about anything else is `invalid`.
- A handle's WebFinger answer is only a claim: the actor found must have the handle's name
  (case aside) and the sigil's kind (`@` a Person or a Service, the bots; `!` a Group), or the
  resolution is `invalid`. The actor may live on another host than the handle's (split
  domains). A document that changes what kind of actor an id is (the store throws
  `RemoteActorKindError`) is `invalid` too.
- Resolutions in flight are shared by actor id and the freshness asked for: a refresh does not
  join a resolution that would return the held copy.
- The stored keys follow the document: a key it drops, or one we cannot use, is removed at the
  next refresh and a changed one replaced. An actor that sent a Delete stays deleted: a later
  fetch does not restore the profile.
- Resolving an actor also reads its instance's NodeInfo when that is missing or a day old, so
  the Announce shape for its server is known before its first post.

`fetchActivity(url, fetch, { maxRedirects = 0 })` (`actors/document.ts`) reads any ActivityPub
document and returns `{ json, url, hops }`: `url` is where it finally came from and `hops` the
redirects followed. Redirects are followed here, one request per hop with safeFetch's own
following switched off, so every hop is checked again and a caller that counts requests counts
them. Only actor documents allow redirects (three); collections and objects are where their id
says and follow none. WebFinger and NodeInfo reads keep three.

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

**What Mastodon-like inboxes get.** Mastodon drops an Announce of anything but a post it can
resolve, so a local community's other traffic is not sent to them. A Mastodon-like inbox is
sent posts only (`publishInCommunity`, `delivery/publish.ts`); threadiverse inboxes are
unchanged.

| Local event                                    | Threadiverse and unknown inboxes   | Mastodon-like inboxes                                               |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| new post                                       | `Announce(Create(Page))`           | `Announce(Page)`                                                    |
| edit of a post                                 | `Announce(Update(Page))`           | `Update(Page)` signed by the author, direct, not announced          |
| author delete                                  | `Announce(Delete)`                 | `Undo(Announce)` by the community, then the author's `Delete`       |
| moderator removal, local author                | `Announce(Delete)` with the reason | the same as an author delete (the `Delete` has no summary)          |
| moderator removal, remote author               | `Announce(Delete)` with the reason | `Undo(Announce)` only: there is no key for the author               |
| remote `Delete` of a post, relayed             | the received bytes, origin skipped | `Undo(Announce)`, plus the author's `Delete` if the author is local |
| ban with `removeContent`                       | `Announce(Block)`                  | the removal's withdrawal for each of the member's removed posts     |
| restore, lock, unlock, pin, ban, comment, vote | as before                          | nothing                                                             |

`delivery/withdraw.ts` does the withdrawal. The boost is the community's stored
`Announce(Page)` of the post (`activities`: `type Announce`, `object_ap_id` the post's id);
`boostsOf` lists the ones with no stored Undo, with the inboxes of their `deliveries` rows.
`withdrawBoosts` queues an `Undo(Announce)` (raw JSON, `undoAnnounce`, served at its id) to those
inboxes and to the Mastodon-like followers now, so an instance that unfollowed since still hears
of it, then the author's `Delete` to the same inboxes when the author is local. The stored Undo
(`object_ap_id` the Announce's id) marks the boost withdrawn, so a second event queues nothing,
and a post never boosted queues nothing. It follows Mastodon's `undo.rb` (an Undo of an
Announce is found by the Announce's id and the booster) and `delete.rb` (a Delete is found by
the author, and `RemoveStatusService` takes the boosts with it).

Restoring is not sent to Mastodon-like inboxes: Mastodon keeps a Tombstone of what it deleted
and refuses a `Create` of it, so a restored post stays gone there. An unlock, a pin and a ban
change nothing a Mastodon user sees. A ban with `removeContent` removes the member's posts
without an event each, so the relay withdraws up to 200 of the member's removed, still boosted
posts per event (`removedBoostedPosts`); a second event takes the rest.

**Site bans.** A `mod.ban` with `communityId: null` (a local moderator banning a person from the
whole site) is a `Block` of the person with the instance actor (`<origin>/`) as `target`, signed
by the moderator and sent straight to every peer we trade follows with (`peerInboxes`), not
announced, as an account's deletion is; an unban is the `Undo` embedding it. Inboxes of an
instance where `deliveryBlocked` (`core/src/peers/gate.ts`, lane MODF's) is true are left out.
With `removeContent` the person's removed posts are taken down without an event each, so the
relay withdraws their boosts from Mastodon-like followers in batches of 200 until none is
left, in every local community. A site ban by a remote moderator is not ours to send.

**The kill switch.** With the `delivery.enabled` site setting off, `deliverDue` claims nothing:
rows stay pending (attempts uncounted) and go out once it is on again. A run that is under way
stops before its next batch.

**Mentions.** A post or comment that names a remote person (`@name@host`) we hold adds that
person to the `cc` of the activity and of the Page or Note, and the Mention `tag` as before.
When no Announce reaches the person's inbox (it is not a follower inbox the activity goes to),
the author's own activity is also sent to it directly, signed by the author, as Lemmy does. An
unknown handle stays text, and a mentioned community (`!name@host`) is tagged but never
addressed: an activity sent to a community's inbox is read as a post to it. The Page or Note served
at its id (`actors/serve.ts`) has the same `tag` and `cc`, so what a peer fetches matches what was sent.

**The worker.** `federation.delivery_queue` runs every two seconds. A row is claimed with
`FOR UPDATE SKIP LOCKED` and a 60 second lease (the request times out at 15 seconds), the
activity is signed once, POSTed with no redirects and a 64 KiB response cap, and the outcome
recorded. A worker that dies leaves a lease that runs out and the row is sent again, so
delivery is at least once and receivers dedupe on the activity id.

A worker that pauses past its lease cannot undo the worker that took the row over: claiming
counts an attempt, so `attempts` is the row's version. The worker renews its lease just before
the POST (and sends nothing if the row is no longer its own), and records its outcome only
while the row is still `pending` at the attempt it claimed. A stale result is dropped; at
worst the receiver gets the activity twice.

| Answer                                                            | Result                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| 2xx                                                               | delivered                                                   |
| 408, 429, 5xx, a timeout, a connection error                      | retried                                                     |
| every other 4xx (401 and 425 too), any 3xx, a refused destination | failed, never retried                                       |
| an instance `isDormant` reports                                   | skipped, but one probe a day (`core/src/remote/dormant.ts`) |

Retries wait 10 s, 30 s, 90 s, 270 s, 810 s, 2,430 s, 7,290 s, then 6 hours twice (the
spike's schedule, in `delivery/policy.ts`): ten attempts over 54,130 seconds, about 15
hours. A `Retry-After` can lengthen a wait, up to 6 hours. A peer down longer misses the
activity. An instance's NodeInfo is read (`instances.software`, name and version cleaned and
capped at 64 characters) when one of its actors is resolved, which is before its Follow is
accepted, again before the first delivery to it, and once a day after. A server whose NodeInfo
cannot be read gets the FEP-1b12 shape until it can be. A failed read is remembered for ten
minutes in a map that forgets expired entries and holds at most 5,000 origins, and callers that
ask for one origin while its read is running share it.

A row whose handling throws in our own code (not a failed send) follows the same schedule and
ends `failed` at the tenth attempt with the error in `last_error`; it is not retried for ever.

## Follows

`packages/core/src/follows/` holds the service (`requestFollow`, `acceptFollow`,
`removeFollow`, `receiveFollow`) and `followState`, `followedCommunities` for the UI
(`id`, `apId`, `name`, `host`, `local`, `state`, `postingRestrictedToMods`, `sensitive`, `nsfl`;
deleted and removed communities are left out). A
follow of a remote community is pending until its Accept. The job `follows.retry` re-sends an
unanswered Follow with a fresh Follow id 5 and 15 minutes after the first, then leaves it
pending (lemmy.world accepted a second Follow about ten minutes after the first). The job
picks follows by an unfinished stage, not by age, so a worker that was down through the whole
window sends the resend it owes when it returns (one send covers every stage then due).

An Accept, Reject or Undo is matched on what it names, not on the pair alone:

- `follow.accept` takes `{ followApId, followerApId }`: the Follow id and the actor of the
  Follow the Accept embeds must be the stored follow's id and its local follower, and the
  acting community its followee. An Accept that names its Follow by IRI only has no follower to
  check and cannot be applied.
- `follow.remove` takes the Follow id when the activity names one, and the delete is
  conditioned on it, so an old Reject or Undo cannot delete the newer Follow a retry put in
  its place. `follow.receive` rechecks its policy in the write (a ban can land in between).

## For other lanes

- `verifyInboundSignature(request, body)` (`signing/inbound.ts`): the key's owner and key id,
  or a failure reason. An actor is fetched for its key at most once a minute per process;
  FED-B still limits how many distinct unknown actors one sender can make us fetch.
- `enqueueDeliveries(t, { activityApId, senderId, body, inboxes })` (`delivery/queue.ts`) in
  an open transaction; `followerInboxes(db, actorId, { skipOrigin })` groups inboxes by shape.
- `resolveRemoteActor` (an `ActorResolveError` with `reason` `invalid` also covers an id or a
  handle that does not match its document), `storeRemoteActor` (returns `deleted: true` and
  changes nothing for an actor that sent a Delete), `deleteRemoteActor`, `ensureInstance`,
  `isDormant` (`packages/core/src/remote/`). For a document other than an actor use
  `fetchActivity` (`actors/document.ts`), which signs the GET as the instance.
- Resolve the follower with `resolveRemoteActor` before `receiveFollow`: that is what reads
  its server's NodeInfo, and with it the Announce shape.
- `requeueSkippedFor(apId)` (`inbound/queue.ts`) sets the rows that were skipped waiting for an
  object back to pending (used when an object arrives by another route, and by a backfill).
- `src/test/diff.ts` and the corpus tests (`delivery/corpus.test.ts`) compare what we send with
  what Lemmy and PieFed accepted.

## Inbound processing

An inbox POST goes through two steps, so the sender gets its answer fast and nothing is lost.

1. **Receipt** (`inbound/receive.ts`). The exact bytes are verified (draft-cavage, the key's
   owner is the activity's actor) and stored in `inbox_raw` with the request headers that were
   signed. Answers: 202 stored, 401 bad signature, 400 not an activity or not strictly UTF-8
   (the relay sends the exact bytes, which must be exactly the text that was read), 413 over
   512 KiB (also counted while a chunked body streams in), 429 with `Retry-After` for too many
   key lookups from one address or for one host, or a signer or instance over its limits (below),
   503 with `Retry-After` while `inbox.enabled` is off or storage fails. Never 410, 418 or another 5xx. Two more 202s store
   nothing: a repeat (the same body from the same signer, or an activity id already received from
   it, within an hour) and an account's own Delete when we hold no live copy of the account and
   its key cannot be fetched (Mastodon sends it after the account is gone; a held live actor
   with an unknown key is still 401).
2. **The pipeline** (`inbound/pipeline.ts`, run by the `federation.inbound` job, one second
   poll, rows claimed with `SKIP LOCKED`). Per row: classify the document (`classify.ts`: a
   type we do not read, a poll, a bare-IRI Announce and a microblog Note are decided here; a
   batched Announce becomes one Announce per activity), map it (`mapping/`), then the
   handler's `prepare` does all network work (resolving actors, fetching an announced
   activity from its own origin) and returns an `apply` step. One transaction then writes the
   dedupe marker (the inner activity's id inside an Announce, so a direct and an announced
   copy apply once), runs `apply` through core mutations, records the `activities` row linked
   to `inbox_raw`, queues the relay's deliveries, puts rows that waited for what was just stored
   back to pending, and settles the row. No network runs inside the transaction. A skip rolls
   all of it back.

Every row ends `applied`, `skipped` with a reason in `inbox_raw.error`, or `failed` (a document
the mapping cannot read, never retried). A transient failure (a peer down, a database error,
a unique violation from two first deliveries racing) leaves the row `pending` for a retry with
backoff, `failed` after eight tries. Reasons are the closed set in `inbound/reasons.ts` plus
core's `RefusalReason`s.

### What the inbox costs us

`inbound/throttle.ts` keeps four budgets in one-minute windows in memory, per process, none
shared, so one kind of traffic cannot spend another's:

- **Discovery**: finding the key of a signer we do not hold. Anyone can sign with a key id of
  their choosing, so a request from a stranger is an invitation to make us fetch. Finding a key
  is one lookup however many fetches it makes (the key document, the actor, its NodeInfo; at
  most eight), charged once at its first fetch: to the client address first and alone (10 a
  minute), so a flood of made-up key ids naming a real peer's host from one address is refused
  before it spends anything that host's genuine signers need; then to the host the key id names
  (20) and in all (120).
- **Refresh**: the same lookup when the key id names an actor or a key we hold (a rotated key,
  an actor presented under a key id we have not seen): 10 an address, 30 a host, 200 in all.
  Counted apart, so strangers cannot keep a held actor's rotation from being found. An actor is
  also looked up for its key at most once a minute, whether or not the fetch worked, but only a
  fetch that was admitted spends that minute: a fetcher that refuses to send throws
  `FetchRefused` (`signing/inbound.ts`) and the attempt is taken back.
- **Pipeline fetches**: 120 a host and 1,200 in all a minute, spent only after the signature
  verified and never refunded, plus an allowance of 60 for one claim of a delivery.
- **Intake**: 300 requests a minute per signer and 1,200 per instance, counted after the
  signature verifies, so only a peer's own key spends its allowance.

The address is the client's, not the proxy's: web's bridge resolves it (`clientIp`, which reads
a header only when `PEBLISH_TRUSTED_PROXY` names the proxy that sets it) and passes it as
`handleFederationRequest(request, { peer })`, which hands it to `receiveInbound(request, { peer })`.
`inbound/client.ts` applies the same setting to the request's headers on top of that, and falls
back to `request.ip` only for a caller that passes none. Every table is bounded (2,000 windows a
budget, 5,000 receipts): past the cap the oldest window is forgotten, which loosens one key's
count while the totals keep counting.

Admission is atomic per instance. Once the signature verifies, a repeat (the same body from the
same signer, or an activity id already received from it, within the hour) is recognised first and
answered 202 at no cost to the signer's allowance, also after the allowance is spent. Then intake
is charged, and the repeat check, the pending bytes (8 MiB per signer, 32 MiB per instance, counted
in the database with the incoming body) and the insert are one step under an advisory lock on the
instance, held to the commit, so concurrent identical or large requests are counted in turn and
cannot all pass on the same count.

A fetch the pipeline's budgets refuse is a wait, not a failure. The row goes back to pending
after 5 seconds when its own allowance of 60 was spent, or 30 when the process-wide window was,
and the attempt it used is given back (`yieldLater`), so a delivery that keeps waiting for
fetches cannot run out of its eight tries. A batch member is started only while at least six
fetches are left (a new origin costs about four: the object, the actor and two NodeInfo reads);
members already applied stay deduped and the rest resume on the next claim, so a 200-member batch
over new origins completes across claims. A claim that applied nothing new before it spent its
own allowance still counts as a failure.

The pipeline looks communities up by their stored row or the Announce's community and fetches
one only when it is the sender, Follow and Undo(Follow) name stored local Groups and never fetch,
and a Delete or Undo resolves its sender with the copy we hold however stale (a refetch answering
410 would delete the actor before its Delete is read and drop `removeData`).

A row is claimed under a lease whose generation is `attempts`; settling, retrying and renewing
match it, so a worker whose lease ran out gets `ClaimLost`, which rolls its apply back, and the
worker that holds the row finishes it. Leases are renewed per row, per batch member and per
fetch, and every batch member's applying transaction asserts the generation before it commits
(`holdClaim`), so a worker that lost its claim cannot commit a member. A batched Announce settles
as a whole, but each member keeps its own outcome: members skipped as `target.missing` stay
discoverable for the requeue even when another member applied (the row's error names every
missing object, one space apart, so the arrival of any of them puts it back), and reprocessing
counts the applied members as duplicates. `inbound/corpus.expected.ts` pins the outcome and
reason of every corpus fixture.

### Authorization

`inbound/authorize.ts` is the one module that decides whether an activity may change state. An
activity's id and actor share an origin; a created object lives on its author's origin and names
the actor; an activity inside an Announce is on the announcer's origin or read from its own;
an Undo reverses only its actor's activity; content in a remote community counts only in that
community's own Announce; an Announce vouches only for its own community; a community never
authors a post, comment or vote. Who may do what to the target is core's: `grantFor` hands the
policy a remote principal (`announcedBy` names the community whose Announce carried it, decision 10) and a refusal becomes the skip's reason. `matrix.test.ts` runs the spike's 16 cases (N0 to
N15) and asserts the exact reason and that state is unchanged.

### Handlers

One file per ActivityStreams type in `inbound/handlers/` exports `handler` (`prepare`, and `undo`
where the type can be undone); files starting with `_` are shared helpers and not registered.
`Create`, `Update`, `Delete`, `Undo`, `Like`, `Dislike`, `Announce`, `Lock`, `Add`, `Remove`,
`Block`, `Follow`, `Accept`, `Reject`, `Flag`. `Flag` authorizes the report and records it as
skipped `flag.not_handled`; the reports lane replaces its last line. Comments go through
lane D's remote comment mutations (`storeRemoteComment`, `updateRemoteComment`, `deleteComment`,
`restoreComment`). An Update is checked against the stored post or comment before anything else:
a community (Page) or parent (Note) that differs from the stored row is skipped
`community.mismatch` or `parent.mismatch`, and authorization and relay use the stored community.
An Announce whose object is another Announce is skipped `announce.nested`. An author's Delete of a
post or comment writes its `deletion_ledger` row in the same transaction
(`@peblish/core/remote/ledger`: `recordDeletion`, and `recordRestoration` for the Undo); an
account's Delete is `deleteRemoteActor`, called in `prepare` outside any transaction because it
runs its own, and counts as applied when it removed content even if the account was already gone.
A moderator's Delete of a whole community is skipped `community.delete_unsupported`.

### Relay and outbound moderation

What reaches a local community directly (a post, a comment, a vote, a remote moderator's
action) is applied and then announced by the community to its remote followers except the
sender's server (`relay/announce.ts`). The Announce embeds the received bytes exactly,
spliced into the Announce text, because re-serialising parsed JSON changes what Lemmy's strict
parser needs. A new post goes to Mastodon-like followers as `Announce(Page)` instead, and a Delete of a
post takes its boosts back there with an `Undo(Announce)` (above); nothing else is sent to them. A microblog Note
rewritten into a post is relayed as the Page it was stored as, never as the original Note bytes.
`relay/consumer.ts` turns a moderation event taken here (`local: true`, in a local community)
into Delete, Lock, Add or Remove on the featured and moderators collections, Block, and their
Undos, announced to followers, and, for the removal of a post and a ban with `removeContent`, the
withdrawal of its boosts from Mastodon-like followers; a local account's deletion becomes a
Delete of the account; a site ban becomes a `Block` to the peers (above).

### Remote moderators

A remote community's moderators are mirrored from its moderators collection into
`community_moderators` (`source: 'remote'`, core `remote/moderators.ts`). A row grants only
once verified and until `expires_at` (twelve hours after the last confirmation), so a
moderator the peer removed loses authority within a bounded time even if the Remove never
reached us. The mirror is refetched when the community announces an Add or Remove on the
collection and by the `federation.moderators` job before a row runs out. The collection is read
without following a redirect (`fetchActivity(url, fetch, { maxRedirects: 0 })`) from the
community's own origin and must name itself; a moderator who cannot be resolved is left out of
that mirror instead of aborting it, and a collection with nobody in it is not asked again for six
hours (in memory). A community whose collection cannot be reached is deferred for an hour and
one that fails in another way for fifteen minutes (`unreachableMirrorBackoffMs` and
`failingMirrorBackoffMs` in core `remote/moderators.ts`), so twenty failing communities cannot
starve the batch of twenty. A moderator's announced Update(Group) never replaces the stored key,
nor reads it: it is stored with `keys: false` (`storeRemoteActor`), which touches profile fields
only, so a key the community rotated meanwhile survives. The Group's own Update does replace it.

## HTTP and consumers

`src/http.ts` is the HTTP seam. Web's server entry (`packages/web/src/server.ts`, through
`packages/web/src/server/federation.ts`) sends `isFederationRequest` matches to
`handleFederationRequest` before any UI route matches. Federation's outbox consumers live in
`src/<area>/consumer.ts` and its jobs in `src/<area>/job.ts`; the worker runs them beside
core's. Web may import only `@peblish/federation/http` and the consumer registry (lint rule
`web-federation-entry-points`).
