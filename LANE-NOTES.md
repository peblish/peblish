# FR4-FED lane notes

Lane FR4-FED (`fed-c`, port 18325), branch `mvp-w4-fr-fed` from `w4-fixes` (0f091d7). Items FN1 to FN3 of `review-2-findings.md` ("Federation"), with root's responses in `review-2-fixes.md`.

| Item                                                             | Commit  | Proving test                                                                                                                                  | Schema change |
| ---------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| FN1 (P1) backfill unwraps envelopes before the visibility check  | ccb5fd1 | `packages/federation/src/backfill/backfill.test.ts` "refuses a post or comment when any Create, Update or Announce carrying it is not public" | none          |
| FN2 (P2) requests that had not started still start after a pause | 5552f12 | `packages/federation/src/actors/federation-switch.test.ts` "a switch turned off while work is under way" (3 cases)                            | none          |
| FN3 (P2) a rejected body's type and error outlive the cut        | 3bed3e3 | `packages/federation/src/inbound/retention.test.ts` "what the inbox keeps of a rejected body outside the body" (2 cases)                      | none          |

Each proving test was run against the code without its fix and failed there (FN3 with only its two constants added, so the test could import them).

## 1. What landed

- **FN1.** `backfill/run.ts` `entryOf` keeps the Create, Update and Announce activities it unwraps (`Entry.envelopes`, outermost first), for posts and for comments from a post's `context` or `replies` collection. `remote-fetch/object.ts` `storeObject` takes them as `envelopes` and passes them to `inbound/visibility.ts` `notPublic`, which now takes any number of further layers (`notPublic(json, ...envelopes)`; the classifier's one-envelope calls are unchanged). Every layer must name Public in `to` or `cc`, or the item is refused as `content.not_public` before anything is stored. Proof: one outbox lists a followers-only Create with an embedded public Page, a public Announce of a followers-only Create, a followers-only Announce of a public Create, a followers-only Update, and a followers-only Create naming its Page by IRI (the Page is read from its origin, and is public there); a post's context collection lists a followers-only Create of a public Note. All six were stored before the fix. The public post and the public comment next to them are still stored (guard).
- **FN2.** The switch is read immediately before each request goes out:
  - `actors/document.ts` `fetchJson` reads it before every request of a read, each redirect hop included (it was read once, before the first);
  - `remote-fetch/polite.ts` reads it when a request leaves a host's queue (after its wait), and rejects with `FederationPaused`; `fetchJson` lets that through instead of turning it into the peer's `FetchFailure`;
  - `delivery/run.ts` `attempt` reads it last, after the lease renewal, the block check and the media recheck, just before the POST. A row stopped there is released: pending, due as it was, lease cleared, its attempt given back (`release`). A `FederationPaused` thrown anywhere in a delivery's handling (a NodeInfo refresh that does not catch it) is handled the same way, never as a failed send.
    Proof, each forced, not timed: a delivery whose NodeInfo step turns the switch off is not POSTed and is left `pending` at its earlier attempt count with no lease and no error; a 301 answered while the switch goes off is not followed; a fetch queued behind another to the same host, with the switch turned off while the first is in flight, is not sent and rejects with `FederationPaused` (the first completes).
- **FN3.** `inbound/receive.ts` refuses an activity whose `type` is longer than `maxActivityTypeLength` (64) with 400 "the activity type is too long", before anything is stored. `inbound/queue.ts` `boundedError` cuts a settled row's error to `maxErrorLength` (512) characters, an ellipsis last and never half a surrogate pair, except a `target.missing` error, which `requeueWaiting` matches id by id (that row keeps its whole body anyway). `settle` applies it, and so does `retryLater` for the error a waiting row carries. Proof: a 300,000-character type gets 400 and no row; a 64-character type is taken and skipped as `type.unhandled` (guard); a Create whose object has a 300,000-character type settles `skipped` with an `object.unsupported` error of at most 512 characters; a Like waiting for an object with an id over 1,024 characters keeps `target.missing <id>` whole (guard).

## 2. Commits

1. ccb5fd1 Hold every Create, Update and Announce a backfilled item came in to the visibility rule (FN1)
2. 5552f12 Read the federation switch immediately before every request goes out (FN2)
3. 3bed3e3 Bound the activity type and the error a rejected inbox row keeps (FN3)
4. this file

## 3. Verification

- `pnpm check` before each commit:
  - FN1: green, 2,672 passed, 9 skipped (239 files, 5 skipped). The first run failed on Prettier only (`backfill/run.ts`); formatted and rerun in full.
  - FN2: green, 2,675 passed, 9 skipped.
  - FN3: build, typecheck and lint green; tests 2,674 passed, 3 failed, 9 skipped. The 3 were timeouts (default 5 s) while the machine's load average was 30 to 40 from an unrelated build: `inbound/receive.test.ts` "a signer, or an instance, with too much waiting in inbox_raw ...", `nodeinfo/client.test.ts` "expired entries are forgotten ...", `remote-fetch/missing.test.ts` "are asked for newest first ...". Earlier, the same receive test also timed out on FN2's committed code with FN3 stashed, so the load was the cause. Rerun alone once the load fell: 3 files, 37 passed.
- `pnpm build && pnpm e2e` at the end: green; the parallel run 324 passed, 1 skipped; the serial run 33 passed.
- `pg_stat_activity` showed no stuck transaction in any lane's database during the timeouts.

## 4. Decisions and deviations

1. FN1 checks the envelopes in `storeObject` (the one rule, `notPublic`), not before the object is read. So an item whose Create is not public but names its object by IRI costs one GET before it is refused. Checking earlier would split the rule in two; the request budget still bounds the run.
2. FN1: the envelopes are the activities the collection item itself carried. Nothing the backfill reads from elsewhere adds a layer: a Page read again from its origin is checked as a bare object plus the envelopes it was listed in.
3. FN2: `polite()` reads the switch before every request it sends, not only one that waited. That is one more settings query per backfill, missing-object or recheck request, a small cost next to the request itself and the gap between requests.
4. FN2: giving the attempt back lowers `attempts`, the row's version, as the inbox's `yieldLater` already does. A worker whose lease ran out before this claim could then settle the row again until it is next claimed. What it records is the real result of a POST it made, so I kept the pattern instead of adding a column.
5. FN2: `deliverDue` now uses `federationOn()` instead of reading `delivery.enabled` directly. Same setting, one name for it.
6. FN3: an over-long type is refused (400), not stored truncated. No ActivityPub type is near 64 characters (the longest full IRI in use, `https://www.w3.org/ns/activitystreams#Create`, is 44), and the activity would only be skipped as `type.unhandled` anyway.
7. FN3: the bound is in characters, as root's response says (512 characters can be up to about 2 KiB of UTF-8).
8. FN3: `retryLater`'s error for a row that will be tried again is bounded too. It is not terminal, but it is the same column and can quote the peer the same way.

## 5. Requests to root

None needed for these items.

## 6. Requests to other lanes, through root

None. `delivery/recheck.ts` (FR4-MEDIA) was not touched: `delivery/run.ts` still calls its `withheldReason` where it did, and the new switch check comes after it.

## 7. Dependencies added

None.

## 8. For later lanes

- Code that unwraps a Create, Update or Announce to store what it carries must pass the activities it unwrapped to `storeObject` as `envelopes` (or to `notPublic` directly).
- A new request path to a peer goes through `fetchJson`, or reads `federationOn()` itself immediately before sending. A queue or wait in front of a request must read the switch again after the wait. `FederationPaused` is never a peer's failure: wait (release or yield) and give the attempt back.
- Anything stored in `inbox_raw` outside `body` that comes from the peer must be bounded at intake or at settle.

## 9. Left open and risks

- FN3 covers `activity_type` and `error`. `inbox_raw.activity_id` and `actor_ap_id` also come from the body and survive the cut. An actor id is the signing key's owner, an actor we resolved and stored, so its length is bounded by the actor document (512 KiB), and it is kept in `actors` anyway. An activity id is only bounded by the body. Bounding ids (for example, refusing ids over 2,048 characters at the door) touches dedupe and is outside root's response; root may want it as a follow-up.
- FN2 still does not stop a request already in flight when the switch flips (as before). Every request not yet sent is stopped.
- A NodeInfo refresh that is itself stopped by a pause records nothing (unchanged); the delivery behind it then sees the switch off and is released.
