# FX4-FED lane notes

Lane FX4-FED (`fed-c`, port 18325), branch `mvp-w4-fx-fed` from `w4-base` (a606db2). Findings F1 to F3 of `b07-findings.md` ("Federation trust") and root's O1 (the B06 rehearsal incident).

| Finding                                             | Commit  | Proving test                                                                       | Schema change |
| --------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- | ------------- |
| F1 (P1) actor redirect substitutes another identity | d931ad9 | `packages/federation/src/inbound/actor-identity.test.ts` (4 cases)                 | none          |
| F2 (P1) non-public Notes become public posts        | e0d1188 | `packages/federation/src/inbound/visibility.test.ts` (9 cases)                     | none          |
| O1 the switch stops every outbound request          | 40b5326 | `packages/federation/src/actors/federation-switch.test.ts` (9 cases, one per path) | none          |
| F3 (P2) byte admission counts retained bytes        | 93880e1 | `packages/federation/src/inbound/retention.test.ts` (4 cases)                      | none          |

Every proving test was run against the code without its fix and failed there, except the cases marked as guards below.

## 1. What landed

- **F1.** `inbound/pipeline.ts` `resolveActor`, the one resolver behind the activity's actor, every nested activity's actor (`ctx.nested`) and every actor a handler targets (`ctx.actor`: Block, site ban), now requires the resolved actor's `apId` to equal the requested id exactly, after redirects. Otherwise the row is skipped as `actor.id_mismatch <requested id>` (new reason in `inbound/reasons.ts`). The moderators mirror (`inbound/moderators/refresh.ts`) leaves out a collection member whose document redirects to another actor. Alias discovery stays separate: search (`resolve/web.ts`) still follows redirects. Proof: a Lemmy-shaped account Delete with `removeData`, sent by `rogue.test/u/alias` which 301s to `lemmy.test/u/lemmyuser`, directly and inside the followed rogue community's Announce, is skipped and the victim keeps its account and posts; a moderator's Block of the alias (redirecting to `pfuser`) bans nobody; the mirror leaves the alias out. Before the fix all four applied to the victim.
- **F2.** One check, `inbound/visibility.ts` `notPublic`: a post or comment (Page, Article, Video, Note), and every activity layer that carries it, must name Public in `to` or `cc`. It runs before conversion, storage or relay at each entry: `classify.ts` (Create and Update, direct, announced or batched, before a Note becomes a Page; a bare announced object together with its Announce), `handlers/announce.ts` (the copy the origin serves when an announced activity is read again), and `remote-fetch/object.ts` `storeObject` (backfill, missing objects, search, parent fetches). Refusal: `content.not_public <object id>` (new reason), `refused` with that reason from `storeObject`. Proof, Mastodon shapes: a followers-only status mentioning the spike, a direct one, a followers-only reply; Lemmy shapes: a Create not addressed to Public, an Update making `t1` followers-only (the post keeps its title), a bare Page announced by a followed community, an announced Create whose origin copy is followers-only, a fetched object. Each was stored (and the first relayed) before the fix. An unlisted status (Public in `cc`) still applies (guard).
- **O1.** `delivery.enabled` is the federation switch (`actors/federation-switch.ts`: `federationOn`, `assertFederationOn`, `FederationPaused`). With it off:
  - `actors/document.ts` `fetchJson`, through which every peer document is read (actors, signing keys, NodeInfo, WebFinger, objects, collections), throws `FederationPaused` before any request, outside the try that would make it the peer's failure;
  - the backfill (`backfill/run.ts`, checked before each claim, so a queued backfill keeps its attempts), the moderators mirror, the missing-object job and the recheck job (before anything is claimed) do not run;
  - an inbox POST whose key would have to be fetched answers 503 with `Retry-After: 300` (`signing/inbound.ts` returns `{ ok: false, reason: 'paused' }`, `inbound/receive.ts` maps it);
  - an inbox row that needs a fetch goes back to pending after 60 seconds with its attempt given back (`inbound/pipeline.ts`, a third `Refusal`, `paused`);
  - a NodeInfo check records no failure (`nodeinfo/client.ts`); a search answers `resolve.paused` (`resolve/web.ts`);
  - delivery, and with it dormancy probes (a probe is a delivery), already claimed nothing (`delivery/run.ts`, untouched).
    The admin label and help (`web/src/i18n/admin.json`, en and de) now read "Sending and fetching" / "Senden und Abrufen" and say pausing stops every request. Proof: one test per path with work waiting for it (a pending delivery, a queued backfill, a due mirror, a skipped activity waiting for its object, held objects due for a recheck, a NodeInfo check, an actor, a handle, an object and a search, a signed POST from an unknown key, an inbox row from an unknown actor); each asserts the stub fetcher was never called. Eight of nine failed before the fix; the delivery case passed before too (guard for the existing behaviour).
- **F3.** `inbound/queue.ts` `settle` cuts the body of a row settled `failed`, or `skipped` for any reason but `target.missing ` (the rows `requeueWaiting` puts back), to its first 1 KiB (`keptPrefixBytes`). Applied rows keep their exact bytes (the relay's). `inbound/throttle.ts` `takeIntakeBytes`: each instance may store 128 MiB of bodies an hour, and everyone 512 MiB (`intakeByteBudget`), charged in full at admission and refunded when the body is not stored (a repeat, the pending limit, an error); over it the inbox answers 429 with `Retry-After: 300`. Proof: near-512 KiB bodies of an unread type (Move) and a malformed Create keep 1,024 bytes, an applied Like and one waiting for its post keep all of theirs; an instance at its hour's bytes gets 429 while another instance gets 202; at the hour's total everyone gets 429. The repeat case is a guard (repeats were never charged).

## 2. Commits

1. d931ad9 Refuse an actor whose document redirects to another actor (F1)
2. e0d1188 Refuse posts and comments that are not addressed to Public (F2)
3. 40b5326 Make delivery.enabled the federation switch: off, nothing is sent or fetched (O1)
4. 93880e1 Count the bytes the inbox keeps, and drop what it rejects (F3)
5. this file

## 3. Verification

- `pnpm check` green before each commit, no reruns needed: F1 2,630 passed, 9 skipped; F2 2,639 / 9; O1 2,648 / 9; F3 2,652 passed, 9 skipped (235 files passed, 5 skipped).
- `pnpm build && pnpm e2e` at the end: green; the parallel run 324 passed, 1 skipped; the serial run 33 passed (the admin switch specs included).
- Each proving test was also run with its fix stashed (see the table note above).

## 4. Decisions and deviations

1. F1 compares ids exactly, fragments included. A document whose id differs from the requested id only by a fragment is refused too; no captured peer does that.
2. F1 also covers the moderators mirror's members, which is not the pipeline proper: a redirecting member is left out, as an unresolvable one already was.
3. F2 requires Public on every layer: the object, the Create or Update, and the Announce around either. All 45 captured Announces that carry content, and every captured Create, Update and fetched object, are public at every layer (surveyed over `test/fixtures/wire`), so none is refused.
4. F2: an Update that would make a public post non-public is refused, so the post stays public as it was. Removing it instead would let a peer delete by Update; root may want that later.
5. F2 changed two older tests whose hand-written documents had no addressing at all (`inbound/pipeline.test.ts` "a document the mapping cannot read", `remote-fetch/object.test.ts` community mismatch): they now name Public, so they still test the mapping failure and the community mismatch.
6. O1: the gate is in `fetchJson` (federation) plus a check at the start of each job, so `core/src/net/**` needed no hook; core's own requests (S3, the scanner, link previews when a person submits a link, the remote media proxy) are not federation and are not gated. The media proxy and link previews keep their own switch (`remote_media.enabled`).
7. O1: the switch is read once per document fetch (one query). It is not cached, so a flip takes effect on the next request.
8. **Deviation (write set):** the label change broke two e2e assertions that quote it; `e2e/admin/settings.serial.spec.ts` and `e2e/admin/switches.serial.spec.ts` now say "Sending and fetching" (one string each). The pause and resume buttons still read "Pause delivery" / "Resume delivery": they are not the label or help, so I left them.
9. F3: the byte budgets are per process, in memory, like the other inbox budgets in `throttle.ts`. Counting retained bytes in Postgres per request would need an index on the instance (inbox_raw has none: `actor_ap_id` prefix scans), which is root's schema; with one web process this is the whole server's budget. The charge is the full body at admission, an upper bound of what is kept, since a cut at settle happens in the worker and cannot refund a web process's window.
10. F3: rows are cut to a 1 KiB prefix rather than emptied, so an admin can still see what a rejected body was. `body` stays NOT NULL; no schema change.
11. F3 budget values (128 MiB an hour per instance, 512 MiB in all) are my choice: well above a large Lemmy's steady traffic (a few KiB per activity), and they bound what one process can store at about 42 GiB per instance, 168 GiB in all, over the 14-day retention, most of which a rejected body no longer keeps.

## 5. Requests to root

1. If more than one web process will take inbox POSTs, decide whether the F3 byte budgets should move to Postgres. That needs an `instance` column (or an index usable for an origin prefix) on `inbox_raw`, and a scratch `0012`; tell me and I will do it.
2. Consider renaming the switch's buttons ("Pause delivery" / "Resume delivery", en and de) to match the new label, for example "Pause sending and fetching". Not done: outside the named strings.
3. The cutover runbook can now say the worker may start with imported follows while `delivery.enabled` is off: nothing leaves the server until it is turned on.

## 6. Requests to other lanes, through root

None. `packages/federation/src/delivery/**` (FX4-MEDIA) was not touched; the O1 test imports `delivery/run.ts` `deliverDue` only to call it.

## 7. Dependencies added

None.

## 8. For later lanes

- A new path that reads a peer's document must go through `fetchJson` (`fetchActivity`), which holds the switch; a new job that fetches should also return early on `federationOn()` so it claims nothing. Catch `FederationPaused` only to wait, never as a peer's failure.
- Every post or comment that reaches storage must pass `notPublic` (`inbound/visibility.ts`); `storeObject` already does for fetched objects.
- Actor resolution in the pipeline goes through `ctx.actor` / `env.actor`, which refuse a redirected identity. Code outside the pipeline that resolves an actor and authorises it (as `remote-fetch/object.ts` `authorOf` does) must compare `actor.apId` to the id it asked for.
- Skipped rows other than `target.missing` keep only 1 KiB of their body: anything that would re-run them must not rely on the body.

## 9. Left open and risks

- F3's budgets are per process (decision 9).
- O1 does not stop a request already in flight when the switch flips; the next document read or job run stops.
- A rehearsal worker that started before this lands keeps the old behaviour; root's interim rule (no worker with imported follows) still applies until it is deployed.
