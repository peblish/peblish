# Lane FED-B: inbound federation

Branch `mvp-w2-fed-b`, cut from e886daf. Nothing is pushed. The tree is clean at the last commit.

**Base verified against:** `mvp-w2` at 55ba9a7 (the batch A fix branches b1, b2, f, fed-a and ui, then lanes D,
C1 and COMPOSER, then round A's follow-up commits), merged into this branch with three merge commits (d809b95,
20113ac, 6a414e9). The one conflict was
`packages/federation/README.md` (FED-A's layout and "For other lanes" text and mine); both are kept. `pnpm check`
and `PEBLISH_UI_KIT=1 pnpm e2e` ran on the merged tree (section 3). Migration 0005 came with the merge; this lane
adds none.

## 1. What landed

- **Receipt** (`packages/federation/src/inbound/receive.ts`). Replaces the 503 stub. The signature is
  verified, the exact bytes go into `inbox_raw` with the signed headers, and the answer is 202. Other
  answers: 400 (not an activity), 401 (bad signature or a key whose owner is not the activity's
  actor), 413 (over 512 KiB by `Content-Length` or counted while a chunked body streams in), 429
  (too many unknown-key fetches at once, `throttle.ts`), 503 with `Retry-After` (`inbox.enabled` off, or
  storage failed). Never 410, 418 or another 5xx.
- **The pipeline** (`pipeline.ts`, `queue.ts`, `job.ts`). Job `federation.inbound` leases pending rows
  (`SKIP LOCKED`, 300 s lease), classifies, maps, calls the handler's `prepare` (all network), then one
  transaction does dedupe, apply, `activities` row, relay, requeue of waiting rows and the row's
  end state. A skip or refusal rolls the transaction back and is recorded as the bare reason in
  `inbox_raw.error`. A `MappingError` is `failed` and never retried. Anything else is transient: backoff,
  `failed` after 8 tries.
- **Authorization** (`authorize.ts`, `reasons.ts`). Origin rules, community rules, the principal handed
  to core (`announcedBy` names the community whose Announce carried the activity, decision 10).
  `matrix.test.ts` runs N0 to N15, 16 of 16, with exact reasons, and asserts state is unchanged for
  every refusal. N9 goes through `receiveInbound` with a real signed request.
- **Handlers**, one file per type in `inbound/handlers/`: `announce`, `create`, `update`, `delete`,
  `undo`, `like`, `dislike`, `lock`, `add`, `remove`, `block`, `follow`, `accept`, `reject`, `flag`. Shared
  helpers start with `_` and are not registered (`_content`, `_vote`, `_lock`, `_ban`, `_collection`).
  Inbound Lock (and Undo), featured Add and Remove, and community Block (and Undo) all apply, both
  inside a remote community's Announce and sent straight to a local community by a moderator
  appointed there (`moderation.test.ts`, from the captured Lemmy and PieFed documents). `flag.ts`
  authorizes the report (`report.not_local` for content not hosted here) and then throws
  `skip('flag.not_handled')`; lane REP replaces that last line.
- **Relay** (`relay/announce.ts`). What reaches a local community directly is announced to its
  remote followers except the sender's server. The Announce text embeds the received bytes exactly
  (spliced between the Announce's own members, `announceText`); a new post goes to Mastodon-like
  followers as `Announce(Page)` instead. It runs in the applying transaction. Content that arrived
  inside a remote community's Announce is not relayed (that community's business).
- **Outbound moderation** (`relay/consumer.ts`, `relay/moderation.ts`). Consumer `federation.relay`:
  `mod.remove` (Delete with the reason, Undo(Delete) embedding the Delete we sent), `mod.lock`,
  `mod.feature` (scope `community`; the front-page pin is not federated), `mod.ban` (Block with
  `expires` and `removeData`, Undo(Block)), `mod.role` (Add or Remove on the moderators collection),
  `actor.deleted` of a local Person (Delete of the account to `peerInboxes`). Only `local` events in
  local communities; a site ban (no community) is MODF's.
- **Remote moderators mirror**. Core: `remote/moderators.ts` (`mirrorModerators`,
  `communitiesDueForMirror`, `moderatorsTtlMs` 12 h, `refreshWithinMs` 2 h, `maxMirrored` 50) and
  policy `authz/actions/remote-moderators.ts` (`remote.moderators_mirror`, system `import` principal
  only, remote non-closed Group only). Federation: `inbound/moderators/refresh.ts` (fetch, resolve,
  mirror) and job `federation.moderators` (every 15 min). Rows are `source: 'remote'`, verified at
  mirror time, expiring in 12 h, so a moderator removed by the peer loses authority within a bounded
  time (spike finding 1). Local rows are never touched. Each change writes a non-public modlog row and a
  `mod.role` event with `local: false`.
- **Comments** go through lane D's remote mutations (`storeRemoteComment`, `updateRemoteComment`, `deleteComment`),
  authorized as the remote principal. The shim this lane carried while D was unmerged is gone.
- `packages/core/src/testing/seed-fed-b.ts`: `seedPeerActor`, `seedFollow`, `seedInboundWorld`,
  `seedLabWorld` (lab-live with the spike's instance as ours), `seedInboxRow`, `inboxState`, `deliverRow`.

## 2. Commits

| Commit      | Subject                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| 2a714d8     | Mirror a remote community's moderators with a verified expiry                     |
| d541d90     | Announce what reaches a local community and federate local moderation             |
| 875970d     | Process inbound activities through one transactional pipeline                     |
| 1750ca7     | Document the inbound pipeline, the relay and the moderators mirror                |
| 02d7326     | Expect a 401 from an unsigned inbox POST in the e2e (outside the write set)       |
| 63c00df     | Test that the moderators job mirrors what is due                                  |
| a3d40f2     | Skip an Accept that names its Follow by IRI only                                  |
| b8f8cab     | Fix the types in the mirror, receive and relay tests                              |
| fd9daf2     | Expect a 401 from an unsigned inbox POST in the http test (outside the write set) |
| d809b95     | Merge branch 'mvp-w2' into mvp-w2-fed-b (batch A fixes; README conflict resolved) |
| 20113ac     | Merge branch 'mvp-w2' into mvp-w2-fed-b (lanes D, C1 and COMPOSER)                |
| 427f28e     | Read the actor name in the community lookup                                       |
| aaccdde     | Sign announced and collection fetches, skip an Update of a deleted actor          |
| fdc814e     | Store, edit and delete comments through lane D's remote mutations                 |
| 5ed3bba     | Test the merged contracts: id conflict, the accepted follower, a deleted actor    |
| (this file) | Add the FED-B lane notes                                                          |

## 3. Verification

On the merged base (mvp-w2 at 55ba9a7 plus this lane):

- `pnpm check`: build, typecheck, `gen`, oxlint `--deny-warnings`, dependency-cruiser, Prettier and the full
  Vitest run pass (128 files and 1808 tests passed, 3 skipped).
- `PEBLISH_UI_KIT=1 pnpm e2e`: 176 passed, 1 skipped, **5 failed, none in this lane**. The same five fail
  identically on a clean checkout of `mvp-w2` at 55ba9a7 (same fresh database): `e2e/composer/composer.spec.ts:152`
  (a search box where none is expected), `e2e/feeds/feeds.spec.ts:101` (a sensitive post in the signed-out HTML),
  `e2e/shell/hydration.spec.ts:41` (`ERR_NAME_NOT_RESOLVED` console error), `e2e/shell/pre-hydration.spec.ts:82`
  and `e2e/shell/shell.spec.ts:64` (the sidebar's `Local` link matches two links once the feeds specs have made a
  community whose name contains `local`). `e2e/server/federation.spec.ts` passes. Before the merge (e886daf base)
  e2e was 99 passed, 1 skipped, 0 failed.
- Focused: `src/inbound` (matrix 17, receive 6, pipeline 20, moderation 8, corpus 1, handlers registry), `src/relay`
  (6), core `src/remote/moderators.test.ts` (6). N0, N14 and N15 run against D's real comment mutations with the
  same exact reasons (`community.banned`, `post.locked`).
- The matrix and the atomicity test (fault between apply and enqueue) were run three times in a row (on the
  pre-merge base, and again as part of the full runs after it).
- Two tests that asserted the 503 stub (`e2e/server/federation.spec.ts`, `packages/federation/src/http.test.ts`)
  are now 401 expectations.
- `git status` shows nothing under `packages/core/drizzle/` and no schema change from this lane: no migration needed.

## 4. Decisions and deviations

1. **Signature at receipt, authorization in the pipeline.** The row stores the headers that were signed
   so the check can be repeated. The pipeline treats the key's owner as the activity's actor.
2. **Dedupe by the applied activity's id** (the inner one inside an Announce). A direct and an announced
   copy apply once. An Announce's own id is not a dedupe key.
3. **Direct content in a remote community is skipped** (`community.unannounced`): it counts only in that
   community's own Announce or from the community itself. This is what the corpus's peer-log activities show.
4. **A community never authors a post, comment or vote.** The handlers refuse a Group sender with
   `actor.group_cannot_act` before building anything (coordinator's contract: B1 and D refuse the same
   later with `post.group_cannot_act` and `comment.group_cannot_act`; my check fires first and the two
   agree, keep both).
5. **Top-level Note** to a local community is a post, per decisions.md: title is the first line, body
   the whole text. A Note that is not addressed to a community here is `note.no_local_community`.
6. **Question, bare-IRI Announce, Move and other types** are skipped with a reason (`type.question`,
   `announce.bare_iri`, `type.unhandled`), as decided.
7. **Batched Announce** (PieFed): each activity inside is processed on its own, at most 200 per Announce.
   The row's end state is applied if any applied, else the lead skip (a missing object is recorded alone
   so the requeue finds it).
8. **Update of an unknown post is stored like a Create**, as Lemmy does. An Update(Note) of an unknown
   comment is `target.missing`.
9. **No comment restore for an author's Undo(Delete)**: `undo.unsupported` (D's `deleteComment` has no
   restore). A moderator's restore goes through AZ's `restoreContent`.
10. **Remote NSFW** (`sensitive` or `nsfl`) is refused by default (`content.nsfw_rejected`); the setting
    comes with ADM.
11. **Remote actor summaries stay raw.** `storeRemoteActor` stores a peer's `summary_html` as sent; the
    read side (`readCommunity`) sanitises. Nothing in this lane renders, forwards or sanitises it, and it
    must not be pre-sanitised at store (the media-proxy rewrite would run twice). The comment in
    `handlers/update.ts` says so.
12. **Throttle is per process and in memory** (`throttle.ts`: 20 key fetches per host and 200 in total per
    window). Enough for one worker; REM may move it to the database.
13. **B1 contract changes** (now merged and tested): a Create of an id held under another community is
    `post.id_conflict` (skipped, tested). A unique violation on store is not caught; it is thrown as a
    plain error, so it is transient and the row is retried (the retry then sees `created: false`, which
    is `object.exists`, or `post.id_conflict`, a permanent skip). `created: false` from `storeRemotePost`
    means a true redelivery only. `updateRemotePost` return value is not used. The relay does not
    check that an Update changed anything, so an identical Update under a new activity id is still
    announced (harmless).
14. **`afterApply`** in `PipelineOptions` is a test hook, run inside the transaction between apply and
    enqueue, so the atomicity test can inject a fault.
15. **`e2e/server/federation.spec.ts` and `packages/federation/src/http.test.ts` changed** although they are
    root's and FED-A's: each asserted the 503 stub and could not pass once the stub was replaced. Each is a
    separate commit; keep or re-apply them.
16. **`packages/federation/README.md` changed** (FED-A owns it): the layout rows for `inbound/` and
    `relay/`, one line in "For other lanes", and the "Inbound processing" section. A separate commit.
17. **Comments use `requireContent` for the parent, not D's `resolveReplyTarget`.** The handler needs the
    parent's community for the origin checks as well, and `storeRemoteComment` checks that the record replies
    to the post or comment the grant names.
18. **FED-A fix branch hand-off.**
    - `follow.accept` takes `{ followApId, followerApId }`: the Accept handler passes the follower of the Follow
      it embeds (a test sends an Accept naming the wrong follower: `follow.mismatch`). An Accept that names its Follow by IRI only is skipped `accept.unverifiable` (classify.ts).
      A Reject by IRI is still read, since it names the Follow id core conditions the delete on.
    - The follower of a Follow is resolved with `resolveRemoteActor` before `receiveFollow`: it is the
      activity's sender, which `contextFor` resolves for every activity. `ActorResolveError('invalid')` is not
      transient, so it is the skip `actor.unresolvable`.
    - **Deviation:** `Undo(Follow)` still removes the follow with `apId: null` (whatever Follow id the
      follower holds now), not with the id the Undo embeds. Lemmy mints a fresh Follow id inside its Undo
      (as it does for Undo(Like)), so conditioning on the embedded id would refuse a real unfollow. No
      Undo(Follow) is in the captured corpus; LAB should confirm. `follow.remove` still requires the actor
      to be the follower, and a Reject is conditioned on the id it names.
    - Announced activities from another origin and the moderators collection are read with `fetchActivity`
      (signed as the instance). `storeRemoteActor` returning `{ deleted: true }` is the skip `target.deleted`:
      an Update of an actor that sent a Delete changes nothing (tested).
    - The key-fetch bound is `throttle.ts` (per host and in total); `verifyInboundSignature`'s own once a
      minute per actor is separate. No product code in this lane imports `@fedify/fedify`.

## 5. Requests to root

**a. Files outside my write set that I changed** (separate commits, drop or keep):
`e2e/server/federation.spec.ts` and `packages/federation/src/http.test.ts` (each asserted the 503 stub; an
unsigned POST is now a 401) and `packages/federation/README.md`.

**b. README ownership table, FED-B row.** It lists only `packages/federation/src/inbound/**`. It should be
`packages/federation/src/{inbound,relay}/**`, `packages/core/src/remote/moderators.ts` (plus its test),
`packages/core/src/authz/actions/remote-moderators.ts`, `packages/core/src/testing/seed-fed-b.ts`.

**c. Tables to migrate: none.**

Nothing else is needed from root: the comments seam, `fetchActivity` and the B1 and FED-A contract changes are
all wired and tested on the merged base.

## 6. Requests to other lanes

- **D:** nothing. See decision 18 for why `resolveReplyTarget` is not used.
- **REP:** replace the last line of `inbound/handlers/flag.ts` (`throw skip('flag.not_handled', ...)`);
  the report is authorized as hosted here (`authorizeReport`) before that line.
- **MODF:** a Block of a whole instance is `block.instance_unsupported` (`handlers/block.ts`), and the
  relay ignores `mod.ban` with `communityId` null.
- **ADM:** `content.nsfw_rejected` in `handlers/_content.ts` is where the remote NSFW setting is read.

## 7. Dependencies added

None.

## 8. For later lanes

**REM**

- Nothing prunes `inbox_raw`: applied, skipped and failed rows keep their bodies (up to 512 KiB).
- `requeueSkippedFor(apId)` (`inbound/queue.ts`) sets the rows skipped as `target.missing <apId>` back to
  `pending`. Call it after a fetched object is stored (the pipeline already does it for anything it
  stores itself). Skipped rows carry the text `target.missing <ap_id>`.
- A missing object is not fetched. Votes, edits and moderation for a post we never saw are skipped
  with `target.missing` and wait for it.
- `mirrorNow(communityId)` and `mirrorDue()` are in `inbound/moderators/refresh.ts`. The first
  mirror of a newly followed community waits for the next `federation.moderators` run (up to 15
  minutes); call `mirrorNow` when an Accept(Follow) is applied if that is too slow. The collection is also refetched when
  the community announces an Add or Remove on it.

**LAB (live checks)**

- Announced activities from another origin (Lemmy announcing a PieFed user's post) are read again from
  their own origin (`embedded.unverifiable` if it does not serve them). Confirm PieFed serves
  `/activities/...`.
- Mastodon-style LD-signature forwarding is rejected at receipt (the signer is not the actor).
- Confirm a real Lemmy accepts the relayed Announce with its bytes unchanged, and that a Mastodon-like
  follower gets `Announce(Page)`.
- Real remote moderator add and remove, and the 12 hour expiry against a live peer.

## 9. Left open and risks

- `inbox_raw` grows without bound until REM prunes it.
- The in-memory throttle does not see other workers.
- A first delivery of one object into two communities racing can surface a unique violation; it is
  retried, not lost.
- The mirrored moderators modlog rows are non-public by design (they record what the peer published).
- Peer-sent HTML in remote actor summaries is stored raw (decision 11).

## Corpus coverage

Every inbound and peer-log document of the Phase 0 captures (106: Lemmy 71, PieFed 35) is replayed
through the pipeline on lab-live with the spike's instance as ours (`corpus.test.ts`, `CORPUS_REPORT=1`
prints the table). Result: **36 applied, 70 skipped with a recorded reason, 0 failed, 0 left pending.**

Skips by reason: Lemmy `object.exists` 15, `community.unannounced` 12, `echo.own_activity` 10,
`mod.moderator_required` 8, `duplicate` 5, `target.deleted` 3, `flag.not_handled` 1, `vote.unchanged` 1.
PieFed `object.exists` 9, `target.deleted` 3, `duplicate` 2, `flag.not_handled` 1.

What the reasons mean in the replay: `object.exists` and `duplicate` are documents the lab world already
holds (stored posts and comments, Accepts already applied). `echo.own_activity` is our own Announce coming
back in the peer log. `community.unannounced` is direct traffic in a remote community. `mod.moderator_required`
is moderation by a Lemmy user who is not a moderator of the spike's community. `target.deleted` is a Delete
of something already deleted. `flag.not_handled` is the Flag, routed to the stub.

### Lemmy 0.19.21

| Activity                 | Applied | Skipped, by reason                                                     |
| ------------------------ | ------- | ---------------------------------------------------------------------- |
| `Accept(Follow)`         | 0       | duplicate x3                                                           |
| `Add`                    | 0       | community.unannounced x1, mod.moderator_required x1                    |
| `Announce(Add)`          | 1       | none                                                                   |
| `Announce(Block)`        | 1       | none                                                                   |
| `Announce(Create(Note))` | 0       | object.exists x1, echo.own_activity x1                                 |
| `Announce(Create(Page))` | 0       | object.exists x3, echo.own_activity x1                                 |
| `Announce(Delete)`       | 1       | target.deleted x1, echo.own_activity x2                                |
| `Announce(Like)`         | 0       | echo.own_activity x1                                                   |
| `Announce(Lock)`         | 1       | none                                                                   |
| `Announce(Page)`         | 0       | object.exists x4, echo.own_activity x2                                 |
| `Announce(Remove)`       | 1       | none                                                                   |
| `Announce(Undo(Block))`  | 1       | none                                                                   |
| `Announce(Undo(Delete))` | 1       | none                                                                   |
| `Announce(Undo(Like))`   | 0       | echo.own_activity x1                                                   |
| `Announce(Undo(Lock))`   | 1       | none                                                                   |
| `Announce(Update(Note))` | 0       | echo.own_activity x1                                                   |
| `Announce(Update(Page))` | 1       | echo.own_activity x1                                                   |
| `Block`                  | 0       | duplicate x1, mod.moderator_required x1                                |
| `Create(Note)`           | 0       | object.exists x3, community.unannounced x1                             |
| `Create(Page)`           | 0       | object.exists x4, community.unannounced x3                             |
| `Delete`                 | 0       | target.deleted x1, community.unannounced x2, mod.moderator_required x1 |
| `Dislike`                | 1       | none                                                                   |
| `Flag`                   | 0       | flag.not_handled x1                                                    |
| `Follow`                 | 3       | none                                                                   |
| `Like`                   | 1       | vote.unchanged x1                                                      |
| `Lock`                   | 0       | community.unannounced x1, mod.moderator_required x1                    |
| `Remove`                 | 0       | community.unannounced x1, mod.moderator_required x1                    |
| `Undo(Block)`            | 0       | duplicate x1, mod.moderator_required x1                                |
| `Undo(Delete)`           | 0       | community.unannounced x1, mod.moderator_required x1                    |
| `Undo(Like)`             | 2       | none                                                                   |
| `Undo(Lock)`             | 0       | community.unannounced x1, mod.moderator_required x1                    |
| `Update(Page)`           | 0       | target.deleted x1, community.unannounced x1                            |

### PieFed 1.8.11

| Activity                 | Applied | Skipped, by reason  |
| ------------------------ | ------- | ------------------- |
| `Accept(Follow)`         | 0       | duplicate x2        |
| `Add`                    | 1       | none                |
| `Announce(Add)`          | 1       | none                |
| `Announce(Block)`        | 1       | none                |
| `Announce(Create(Note))` | 0       | object.exists x1    |
| `Announce(Create(Page))` | 0       | object.exists x2    |
| `Announce(Delete)`       | 1       | target.deleted x1   |
| `Announce(Lock)`         | 1       | none                |
| `Announce(Remove)`       | 1       | none                |
| `Announce(Undo(Delete))` | 1       | none                |
| `Announce(Undo(Lock))`   | 1       | none                |
| `Announce(Update(Page))` | 1       | none                |
| `Create(Note)`           | 0       | object.exists x3    |
| `Create(Page)`           | 0       | object.exists x3    |
| `Delete`                 | 1       | target.deleted x1   |
| `Dislike`                | 1       | none                |
| `Flag`                   | 0       | flag.not_handled x1 |
| `Follow`                 | 2       | none                |
| `Like`                   | 1       | none                |
| `Lock`                   | 1       | none                |
| `Remove`                 | 1       | none                |
| `Undo(Delete)`           | 1       | none                |
| `Undo(Dislike)`          | 1       | none                |
| `Undo(Like)`             | 1       | none                |
| `Undo(Lock)`             | 1       | none                |
| `Update(Page)`           | 0       | target.deleted x1   |
