# Remote fetch, backfill and dormant instances (lane REM)

What we remember about peers beyond the document they sent, and how we get the rest.

## Cache figures

`ttl.ts` is the one table (`remoteTtls`). A stored remote actor is fetched again on use after a day (`resolveRemoteActor`), a key that stops verifying makes one refetch of its actor, at most one a minute, a peer's NodeInfo is read again after a day, mirrored moderators expire after twelve hours. The first five are imported from the code that applies them, so the table cannot drift. `ttl.test.ts` checks them on a fake clock.

## Fetching on purpose

- `object.ts`: `fetchRemoteObject(apId, { vouch })` reads a post or comment from its own origin and stores it through the mutations the inbound handlers use (`storeRemotePost`, `storeRemoteComment`), authorized as its author. A `Vouch` names the remote community that stands behind the object: it served the object in its own collection, or announced an activity about it. An object nothing vouches for is not stored. A comment's missing ancestors are fetched first (`maxParentDepth`). A 410 or a `Tombstone` is a deletion (`deleteRemoteObject`, one ledger row).
- `actor.ts`: `refreshRemoteActor(apId)` fetches now. 410 or a Tombstone deletes the actor (`deleteRemoteActor`); a valid document for an actor we hold as deleted undeletes it and stores the document.
- `missing.ts` and `job.ts` (`federation.missing_objects`, every minute): the inbound pipeline skips activities about an object we never saw as `target.missing <ap_id>`. This finds those targets among the skipped rows, fetches each from its own origin under the vouching of the community whose Announce carried the activity, and stores it. Storing puts the waiting rows back to pending (`requeueSkippedFor`), so the next inbound run applies them. An object that is gone or refused is not asked for again by this process; one whose server is down is asked for again after growing waits.
- `polite.ts`: one request at a time to a host, with a gap after each. The backfill and the missing-object job use it.

## Backfill

`../backfill/`: the consumer `federation.backfill` queues a community (`backfills` row) when our follow of it is accepted (`follow.accepted`, local follower, remote Group). The job `federation.backfill_run` (every 30 seconds) claims one under a lease and runs it: refresh the community, then read its `featured` and `outbox` collections, store each post, and for a post that offers a `context` or `replies` collection (FEP-7888) its comments. An embedded object is trusted only when its id is on the community's own origin; any other is read from where it lives. Caps are data in `core/src/remote/backfill.ts` (50 posts, 100 comments a post, 250 requests). What Lemmy 0.19.21 and PieFed 1.8.11 serve: a community's `outbox` (Lemmy: Create activities of its last posts) and `featured` (pinned Pages), advertised on the Group document; their Pages and Notes carry no `context` or `replies`, so comments are not backfilled from them, only fetched when something names one.

## Dormant instances

`core/src/remote/dormant.ts`: an instance whose deliveries failed for seven days and that sent nothing in that time is dormant; `isDormant(instanceId)` (called by the delivery worker for each row) says yes, except once a day, when it lets one delivery through as a probe. A delivered probe or any activity from the instance revives it. The job `remote.instance_health` (every ten minutes) derives all of it from `deliveries` and `inbox_raw`; the figures are `dormancy` in that file.

## Retention

`core/src/remote/prune.ts`: settled inbox rows go after 14 days, settled deliveries after 30 (job `remote.prune`, hourly).
