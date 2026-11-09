# Lane FX-FED notes (wave 3 review fixes)

Branch `mvp-w3-fx-fed`, worktree `/Users/admin/Projects/feddit-mvp-w3-fx-fed`, cut from `w3-review` (96d94dd). `lane.sh` name `fed-c` (database `peblish_fed_c`, port 18325). Findings D3, D7, S1, F1, F3, F5, F6, F7, as `fix-lanes.md` answers them.

## Findings

| Finding         | Commit    | Test that proves it                                                                                                                                                                                                                                                                                                                     |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3 (F2, A3)     | `da33a88` | `delivery/delivery.test.ts` "a peer blocked after the rows were queued gets nothing, also when the row was queued before its instance was known"; `delivery/reports/consumer.test.ts` "an author’s instance blocked after the report was filed gets no Flag; the community’s still does"                                                |
| F1              | `02952bf` | `resolve/web.test.ts` "refuses a post or comment whose author alias redirects to someone else, and stores nothing in their name"                                                                                                                                                                                                        |
| S1 (contract 3) | `1f90379` | `relay/withdraw.test.ts` "a reason kept out of the public modlog": "never leaves: a removal, its restoration, a community ban, its unban and a site ban carry no summary, sent or served" and "a public row’s reason still goes out"                                                                                                    |
| F7              | `4616866` | `core/src/comments/remote.test.ts` "an edit that only changes who is mentioned is an edit: the tags are stored and comment.updated goes out"                                                                                                                                                                                            |
| F3              | `fab0645` | `delivery/consumer.test.ts` "who was named before still gets the edit that drops them, the deletion and the restoration; the edit does not cc them"; `relay/withdraw.test.ts` "reaches the people it was sent to for a mention: the moderator’s Delete, and on a Mastodon-like server the author’s Delete"                              |
| F6              | `6a8723a` | `core/src/remote/prune.test.ts` "a boost’s deliveries outlive the window until an Undo takes it back; other old Announces go"                                                                                                                                                                                                           |
| D7              | `a6b4f1a` | `relay/withdraw.test.ts` "with removeContent takes back one batch in the event’s transaction and the rest in the job’s, only the banned person’s" and "the job takes at most one batch per transaction, and skips a person another transaction is withdrawing" (a second transaction holds the advisory lock, forcing the interleaving) |
| F5              | `c721b94` | `relay/withdraw.test.ts` "a site ban a peer sets on its own person": "with removeData takes the person’s boosts back from Mastodon-like followers, though the Block goes nowhere" (a Lemmy site-ban Block through the inbound pipeline, then the relay on the event it emitted)                                                         |

Each test was run against the code before its fix and failed there (D7's second test fails on import, since `withdrawRemaining` is new). Paths without a package are under `packages/federation/src/`.

## 1. What landed

- **D3** `delivery/run.ts`: the worker reads the peer block for each claimed row twice, before the NodeInfo refresh and again right after the lease renewal, immediately before the POST. By `instanceId` when the row has one (`deliveryBlocked`), otherwise by the inbox URL's host (`instanceBlocked`), so a row queued before its instance was known is covered. A blocked destination settles `skipped` with `the instance is blocked`, never retried. Outbound report Flags use the same queue, so they are covered.
- **F1** `remote-fetch/object.ts` (`authorOf`): after the author is resolved (which may follow up to three redirects), its real `apId` must equal the object's `attributedTo`, or the object is refused `object.author_mismatch` (resolve shows `peer.invalid`) before anything is authorised or stored. `checkObject` had already held the object to that `attributedTo`'s origin, so origin and attribution now both match the real actor. Posts and comments; resolve, backfill and the missing-object job all go through `storeObject`.
- **S1** `relay/consumer.ts` (`wireReason`): a removal, restoration, community ban, unban and site ban carry the reason as `summary` only when the modlog row `event.modlogId` is public; a private or missing row sends none. The stored activity is the delivered text, so the copy served at its id has none either. No event schema change.
- **F7** `core/src/comments/remote.ts`, `core/src/mentions/scan.ts` (`sameMentions`, `mentionHrefs` exported): a peer edit whose Mention tag set changed (order and repeats aside) persists `raw` and emits `comment.updated`, so the notifications consumer sees the new mention.
- **F3** `delivery/records.ts` (`mentionedBefore`), `delivery/publish.ts` (`earlier` option), `delivery/consumer.ts`, `relay/consumer.ts`, `delivery/withdraw.ts`: the people an earlier copy was addressed to, read from the `cc` of each local Create and Update stored for the object (activities are never pruned), are sent post and comment edits, deletions, the post restoration, and a moderator's removal and restoration directly when nothing else reaches their inbox. They are not put back in `cc`. The withdrawal also sends the author's Delete to a Mastodon-like server that got the post for a mention.
- **F6** `core/src/remote/prune.ts` (`openBoost`): delivery rows of a local community's Announce of a post with no local Undo are excluded from the prune; once undone, or once the post is gone, they are pruned as before. No new table.
- **D7** `delivery/withdraw.ts` (`withdrawRemovedPosts`, `withdrawRemaining`, `withdrawalLock`), new job `delivery/withdrawals/job.ts` (`federation.boost_withdrawals`, every 60 s), `relay/consumer.ts`: a site ban with `removeContent` withdraws one batch (200 posts) in the outbox transaction; the job takes the rest one batch per transaction, at most 25 batches a run. `removedBoostedPosts` now only counts posts in a local community that is not deleted, so nothing comes back for ever.
- **F5** `relay/consumer.ts`: a site ban runs the withdrawal whoever set it, including a peer's ban of its own person; only the Block itself is still sent for a local moderator's ban alone.
- `packages/federation/README.md`: the blocked-peer row in the delivery table, the author check after redirects, reasons, earlier mention recipients, the prune exclusion, bounded withdrawal and inbound site bans.

## 2. Commits

1. `da33a88` Skip every delivery to a blocked peer, checked just before the send (D3)
2. `02952bf` Hold a fetched post's or comment's author to the id the object names (F1)
3. `1f90379` Federate a moderation reason only when its modlog row is public (S1)
4. `4616866` Treat a peer's comment edit that only changes its mentions as an edit (F7)
5. `fab0645` Send edits, deletions and withdrawals to everyone a copy was sent to for a mention (F3)
6. `6a8723a` Keep a boost's delivery rows until it is withdrawn (F6)
7. `a6b4f1a` Withdraw a site ban's boosts one bounded batch per transaction (D7)
8. `c721b94` Withdraw boosts for a site ban a peer sets on its own person (F5)
9. `06424da` Document the peer block gate, private reasons, mention recipients and bounded withdrawal
10. This notes file.

## 3. Verification

- `pnpm check` before each commit. Final tree: 2,519 passed, 7 skipped (218 files passed, 4 skipped). The first run, on the D3 commit with its two new tests, had 2,511.
- Three full runs had one unrelated failure each under the shared Postgres load, each green when rerun alone: `inbound/receive.test.ts` (a 5 s timeout, F3 run), `core/src/authz/moderators-cache.test.ts` (a timing poll, F6 run), and the bulk withdrawal tests (5 s timeouts, F5 run, now given 30 s). One F1 run caught an ordering flake in my own D3 test (two rows with the same `createdAt`); it was fixed by sorting and folded into the D3 commit.
- `pnpm build && pnpm e2e` on `06424da`: 353 passed, 1 skipped (354 tests, one run).
- Every test uses fixtures or stubs and this lane's test database; no request to any real server or the lab.

## 4. Decisions and deviations

1. **Deviation (D7).** The brief named "the outbox cursor or a follow-up event" as the continuation. Neither fits: a consumer may not emit a type it consumes (`assertRunnable`), so a follow-up event cannot continue itself, and leaving the cursor unadvanced rolls the work back. The continuation is the data instead: the `site_bans` row with `remove_content` and the boosts no Undo has taken back, read again by a job each run. The job lives under `delivery/` because the `core-tx-access` rule allows raw transactions there.
2. D7: the batch is `BULK_WITHDRAWAL_CAP` (200 posts) per transaction, the existing per-event cap. The job counts only batches that took posts toward its 25 a run, so many finished site bans cannot starve a later one.
3. D7: the advisory lock is `pg_try_advisory_xact_lock(hashtextextended('withdrawal:<actor id>', 0))`, a try-lock in both the consumer and the job. If the job holds it, the consumer's batch is skipped and the job finishes the work. Community bans take it too (their one batch per event is unchanged).
4. D7: a site ban lifted before the job finishes deletes its `site_bans` row, so the remaining boosts of the still removed posts stay. Accepted: the first batch of 200 runs at once, and the job runs a minute later.
5. S1: a missing modlog row counts as private (no summary). Events always carry the id of a row written in the same transaction, so this is a guard, not a path.
6. F3: earlier recipients come from the stored activities' `cc`, not from `deliveries`, so they survive the prune. Only remote people we hold, not deleted, are read back; the community in `cc` is a Group and is never matched.
7. F3: the moderator's Delete also goes to earlier mention recipients directly. On a Mastodon-like server it changes nothing (Mastodon matches a Delete by the author), so the withdrawal's author Delete is what removes the status there. A second removal event of a local author's post that mentions a Mastodon-like person resends that author Delete (new id). Rare (a second removal is normally refused `target.removed`) and harmless.
8. F3: a comment's removal by a moderator reaches earlier mention recipients as the moderator's Delete; no author Delete is sent to Mastodon-like servers for comments (there is no comment withdrawal today).
9. F6: excluded rows are an Announce whose `activities` row is a local Announce of a post (a `posts` row with that `ap_id`) with no local Undo of it. Announce(Create(...)) and relayed Announces have an activity id as object, not a post, and are pruned as before. Each prune batch skips the retained rows through indexed lookups; their number grows with the boosts still live (posts times Mastodon-like inboxes).
10. F1: the reason is the existing `object.author_mismatch`, which resolve already maps to `peer.invalid`; no new reason or copy.
11. D3: no change at enqueue time for reports; the worker gate covers every row whatever queued it.
12. F5: the test sends a Lemmy-shaped site-ban Block through the inbound pipeline (as `inbound/site-ban.test.ts` does). The corpus has no captured Lemmy or PieFed site-ban Block with `removeData: true`; `inbound-0079-block.json` is a community ban.

## 5. Requests to root

- `packages/core/src/posts/remote.ts` (`updateRemotePost`), outside this write set, has the F7 gap for posts when the peer sends no new `updated` time: an Update whose Mention tags alone changed and whose `editedAt` is null or equal is dropped. Exact change: import `sameMentions` from `../mentions/scan.ts` and extend the check to `const same = (Object.keys(fields) as (keyof typeof fields)[]).every((key) => fields[key] === current[key]) && sameMentions(current.raw, post.raw);`.
- No schema change, no new settings key, throttle scope or payload route. The new job name `federation.boost_withdrawals` is registered by glob.

## 6. Requests to other lanes, through root

- LAB: if the Mastodon scenario runs again, a site ban with `removeData` set on a Lemmy user whose post a local community boosted to Mastodon should show the boost gone (F5), and a post mentioning a Mastodon person, then removed by a moderator, should disappear on that person's server (F3).

## 7. Dependencies added

None.

## 8. For later lanes

- `withdrawRemovedPosts(t, { origin, authorId, communityId? })` withdraws one batch under the person's advisory lock and returns the posts taken, or null when the lock is held elsewhere. `withdrawRemaining()` is the job body.
- `publishInCommunity(..., { earlier })` sends `inner` directly to people an earlier copy named without addressing them; feed it `mentionedBefore(db, objectApId)`.
- The delivery worker now treats a blocked peer like a dormant one (skipped), read at send time.

## 9. Left open and risks

- D7 decision 4 (an unban before the job finishes) and F3 decisions 7 and 8 above.
- The F6 exclusion grows with live boosts; if it ever slows the prune, a compact recipient table is the fallback the brief allowed.
- The posts F7 gap (section 5) until root applies it.
