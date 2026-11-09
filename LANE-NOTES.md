# Lane FED-C notes (wave 3)

Branch `mvp-w3-fed-c`, worktree `/Users/admin/Projects/feddit-mvp-w3-fed-c`, `lane.sh` name `fed_c` (port 18325). Status: steps 1 and 2 done. Step 2 merged `w3-groundwork` (35fbc62) and added the `delivery.enabled` check, the site-ban Block and the served mention `cc`.

## 1. What landed

| Deliverable                                                                                                                                                                   | Where                                                                             | Proof                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Withdrawal of a post from Mastodon-like followers: `Undo(Announce)` by the community per earlier `Announce(Page)`, then the author's `Delete` when the author is local        | `delivery/withdraw.ts` (`boostsOf`, `undoAnnounce`, `withdrawBoosts`)             | `delivery/withdraw.test.ts` (author delete, Undo keys and served at its id, no second Undo, never boosted, unfollowed instance), `relay/withdraw.test.ts` |
| Author delete and edit: `Delete` withdrawal; `Update(Page)` signed by the author, direct, not announced                                                                       | `delivery/consumer.ts`, `publish.ts` (`microblog: 'inner' \| { withdraw }`)       | `consumer.test.ts` "an edit is ...", `withdraw.test.ts`                                                                                                   |
| Moderator removal of a post (local author: Undo plus Delete without summary; remote author: Undo only; threadiverse keeps `Announce(Delete)` with the reason)                 | `relay/consumer.ts`                                                               | `relay/withdraw.test.ts`                                                                                                                                  |
| Relayed remote `Delete` of a post: Undo to Mastodon-like inboxes; the received bytes unchanged to the rest, origin skipped                                                    | `relay/announce.ts`                                                               | `relay/withdraw.test.ts` "a Delete the community relays"                                                                                                  |
| Posts-only traffic to Mastodon-like inboxes (restore, lock, unlock, pin, ban, comment, vote no longer go there)                                                               | `publish.ts`, `relay/announce.ts`                                                 | `consumer.test.ts` "everything else ...", `relay/withdraw.test.ts`, `relay.test.ts`                                                                       |
| Ban with `removeContent`: withdraw up to 200 of the member's removed, still boosted posts per event                                                                           | `relay/consumer.ts`, `withdraw.ts` (`removedBoostedPosts`, `BULK_WITHDRAWAL_CAP`) | `relay/withdraw.test.ts` "a ban with removeContent" (three Undos and Deletes, cap 200, then the one left)                                                 |
| Outbound mentions: each stored mentioned remote person added to `cc` (activity and Page or Note) and sent the author's activity directly when no Announce reaches their inbox | `records.ts` (`mentionsIn`, `withCc`), `send.ts`, `publish.ts`, `consumer.ts`     | `consumer.test.ts` "a person a post or comment names"                                                                                                     |
| README: shape table, restore and unlock rules, mentions                                                                                                                       | `packages/federation/README.md`                                                   | n/a                                                                                                                                                       |

Step 2 is in the next section.

## 2. Commits

1. `59da4e4` Take Mastodon-like boosts back, and send them posts only
2. `7e80f2e` Address a mentioned remote person and send them the activity directly
3. This notes file.

## 3. Verification

- `pnpm check` green on each of commits 1 and 2: 2,104 tests passed on commit 1, 2,107 on commit 2 (3 skipped; baseline per `common.md` 2,089). Build, typecheck, lint (boundaries, oxlint, prettier) pass.
- No e2e run: nothing in `web` or `e2e` changed.
- All tests use local fixtures and the test database `peblish_fed_c_test`; no traffic to any real server.

## 4. Decisions and deviations

1. `publishInCommunity` options: `microblog?: 'inner' | { withdraw: string }` as briefed, plus `mentions?: readonly Mentioned[]`. The withdrawal also receives the announced activity (`announced`), so an author's own `Delete` without a summary is reused as the Delete Mastodon gets (one id for the author's act, and the restore Undo's lookup of "the Delete we sent" stays unambiguous). A moderator's Delete carries a reason, so a separate author Delete with a new id is made. If a moderator removes their own post, the two Deletes are stored in one transaction and share `created_at`; `sentId` in `relay/consumer.ts` then may pick either for the restore's embedded Delete id. No wire effect: peers match the Undo by its object.
2. Import cycle: `withdraw.ts` needs `sendActivity` and `publish.ts` needs `withdrawBoosts`, and dependency-cruiser forbids cycles. `newActivityId`, `storeActivity` and `sendActivity` moved to a new `delivery/send.ts`; `publish.ts` re-exports them, so REP's imports from `publish.ts` keep working.
3. The Undo goes, per boost, to that boost's delivered inboxes plus the current Mastodon-like followers (brief item 4). The author's Delete goes to the union over all boosts. Delivery rows are pruned 30 days after settling, so for an older boost the Undo reaches only current followers.
4. The boost is found by `activities` rows (`Announce`, local, actor the community, `object_ap_id` the post). Only `Announce(Page)` rows match that: `Announce(Create(Page))` rows store the Create's id as the object, so threadiverse announces are never withdrawn this way.
5. Mentions: only Person mentions are addressed and sent directly (E2 decision: only `@name@host` is a mention at launch). Group mentions keep their Mention tag but are not put in `cc`: a Create sent to a community's inbox would be read as a post there. A mentioned person's inbox is their shared inbox when they have one, so an instance that already follows the community is recognised as a target. In a remote community the activity goes to the community inbox and to mentioned inboxes that differ from it. A Mastodon-like follower named in a comment is sent the author's Create directly, because no Announce of a comment reaches it any more.
6. An edit of a post by a remote author never reaches Mastodon (no key, brief section 12); only local-author `post.updated` events do.
7. The Delete and Undo for a ban with `removeContent` use `removed_at is not null` posts of the target in that community, newest removal first, with an unwithdrawn boost. Posts removed before the ban by a moderator are covered the same way and are already withdrawn (the stored Undo excludes them).
8. `delivery/corpus.test.ts` is unchanged. The direct `Update(Page)` is the same document the corpus already checks for a remote community, and the Undo(Announce) has no spike or Lemmy reference, so `withdraw.test.ts` pins its keys instead (the ones Mastodon's `undo.rb` reads). The brief asked to add the shape there; I judged it redundant.

## 5. Requests to root

- None blocking.
- When the tag lands, a follow-up task for step 2 (see section 9). It needs, from the groundwork: `deliveryBlocked` in `packages/core/src/peers/gate.ts`, the `delivery.enabled` key in `site-settings.ts`, and `mod.ban` events with `communityId: null` in `events.ts`.

## 6. Requests to other lanes, through root

- LAB: a Mastodon follower scenario (post, edit, delete, moderator removal, ban with removeContent; the boost and the original status gone; the corpus has no Mastodon document), and confirm against a live Mastodon the source readings in the brief (`undo.rb`, `delete.rb`, `update.rb`, `announce.rb`). Also whether Mastodon resolves `Announce(Create(Page))` now that activities are served by id.
- MODF: still open from the brief: does the site ban's remove flag remove posts in bulk without per-post events, and which event does it emit? Needed for the site-ban withdrawal, which is not built.
- E2: the outbound mention `cc` and the direct delivery landed; nothing further is needed from E2.

## 7. Dependencies added

None.

## 8. For later lanes

- `delivery/withdraw.ts`: `withdrawBoosts(t, { origin, community, postApId, announced? })` is safe to call for any post id; it does nothing without an open boost. A lane that removes a post without a `mod.remove` or `post.deleted` event (a site-ban purge, a retention job) can call it from its consumer.
- `publishInCommunity` no longer announces anything but a new post to Mastodon-like inboxes. A new activity type that should reach them needs an explicit `microblog` option.
- `sendActivity` and `storeActivity` take a `cc` argument after `tags` (default none); existing callers are unaffected.
- `mentionsIn` returns the Mention tags and the addressable people; `mentionTags` is unchanged for `actors/serve.ts`.

## 9. Left open and risks

- Step 2 items are done (next section); its own open points are in section 14.
- A Mastodon-like follower cannot see a restored post: Mastodon records a Tombstone for a deleted status and refuses a later Create. Decision 3 of `decisions.md` accepted this.
- PieFed's day-one cap, `comment.restored`, the dormancy hook and the cap on rows one burst queues remain as listed in the brief, section 7 ("Waits, FED-C later").
- Source readings of Mastodon in the brief are from `main` on 2026-11-09 and unverified against a live server until LAB runs its scenario.

## Step 2

Merged `w3-groundwork` (tag 35fbc62) into `mvp-w3-fed-c`: clean, no conflict (merge commit 9f26ddc). Reinstalled `node_modules`.

### 10. What landed

| Deliverable                                                                                                                                                                                                                                                                                                                     | Where                                                                                                                                        | Proof                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliverDue` claims nothing while `delivery.enabled` is off, checked before each batch so a switch turned off mid-run stops the run; rows stay pending with `attempts` unchanged                                                                                                                                                | `delivery/run.ts`                                                                                                                            | `delivery/delivery.test.ts` "with delivery.enabled off ..."                                                                                       |
| Site ban: a `mod.ban` with `communityId: null` from a local moderator is a `Block` of the person, target the instance actor (`<origin>/`), signed by the moderator, stored (served at its id) and sent to `peerInboxes` minus instances where `deliveryBlocked` is true; an unban is the `Undo` embedding the last stored Block | `relay/consumer.ts` (`onSiteBan`), `relay/moderation.ts` (doc only), `delivery/followers.ts` (`deliverableInboxes`)                          | `relay/withdraw.test.ts` "a site ban" (shape and signer, Undo, held-back instance, remote moderator)                                              |
| Site ban with `removeContent`: boost withdrawal for the person's removed posts in every local community, a batch of 200 at a time until none is left                                                                                                                                                                            | `relay/consumer.ts`, `delivery/withdraw.ts` (`removedBoostedPosts` now takes `{ communityId?, limit? }` and returns `{ apId, communityId }`) | `relay/withdraw.test.ts` "with removeContent takes back ..." (205 posts, live and other people's posts stay, a second event sends only the Block) |
| A served Page, Note, pinned Page and outbox Create carry the same `tag` and `cc` of mentioned remote people as the delivered copy                                                                                                                                                                                               | `actors/serve.ts` (`withMentions`)                                                                                                           | `actors/serve.test.ts` "a post and a comment name the remote people ..."                                                                          |
| README: site bans, the kill switch, the served mention `cc`                                                                                                                                                                                                                                                                     | `packages/federation/README.md`                                                                                                              | n/a                                                                                                                                               |

### 11. Commits

1. `0550b0b` Hold deliveries while the delivery.enabled setting is off
2. `e3c854f` Send a site ban to the peers as a Block and take the person's boosts back
3. `cca5935` Serve a post's and comment's mentioned people in cc, as delivered
4. `eb413a7` Document site bans, the delivery kill switch and the served mention cc
5. This section.

### 12. Verification

- `pnpm check` green on the final tree: 2,127 passed, 3 skipped (160 files; step 1 was 2,107). The first full run had five timeouts and one worker assertion in `core` files (`comments/mutations`, `db/migrate`, `outbox/worker`) while the shared Postgres was busy; the same three files passed alone and the rerun was green. They are outside this lane.
- No e2e: nothing in `web` or `e2e` changed.
- Tests use fixtures and the lane's test database; no traffic to any real server.

### 13. Decisions and deviations

1. The site-ban Block is signed by the moderator and sent directly, not announced: there is no community. The wire is the mapping's `Block` with `communityApId: null` (so `to: [Public]`, no `cc`, no `audience`), `object` the person, `target` the instance actor, `summary` the reason, `removeData`, `expires`. Lemmy's own site-ban Block has the same fields.
2. `deliveryBlocked` is read through `deliverableInboxes` (new, `delivery/followers.ts`): inboxes are mapped to instances by host, and a host with no `instances` row is sent to. The stub returns false, so today nothing is held back; the test mocks the gate to prove the skip. Only the Block uses it, as briefed; MODF decides whether the delivery queue itself should also refuse blocked instances.
3. The Undo of a site ban embeds the id of the most recent stored local `Block` about that person (`sentId`), which can be a community ban's Block if that is newer. Receivers match the Undo by its object and target, so no wire effect; the same weakness the community unban already had.
4. The site-ban loop skips posts in a community that is deleted or not local (they would come back for ever) by remembering which it has seen. If 200 of them fill a batch, the loop ends before the posts behind them. Rare enough to leave.
5. The community-ban withdrawal is unchanged: one batch of 200 per event, a second event takes the rest (step 1 test pins it). Only the site ban loops, as the brief says.
6. `removedBoostedPosts` changed signature: `(db, authorId, { communityId?, limit? })` returning `{ apId, communityId }[]`. Its only caller is `relay/consumer.ts`.
7. `mentionTags` in `delivery/records.ts` had no caller once `serve.ts` used `mentionsIn`, so I removed it. Step 1 notes said it stayed for `serve.ts`; section 8 of the step 1 notes is superseded on that point.
8. The "a site ban ... not federated" assertion in `relay/relay.test.ts` was replaced by the site-ban tests in `relay/withdraw.test.ts`, which has the fixtures for peers on both software kinds.
9. Vitest must run from the repository root (`npx vitest run --project federation <file>`); from inside `packages/federation` it skips the root config and runs against the lane's dev database, which left a foreign local-instance row in `peblish_fed_c` twice. I dropped and recreated that database (this lane's own, scratch) both times.

### 14. Requests to root and left open

- None blocking. MODF: the site-ban event contract holds as `decisions.md` says; if MODF's inbound side later wants the Block to also go to the banned person's own instance when no follow links us, that is a one-line addition to the inbox list in `onSiteBan`.
- A site ban by a local moderator whose action is itself an unban of a person who was never site-banned from here still sends an Undo(Block); harmless.
- Still open from step 1: LAB's Mastodon scenario and the live check of the Mastodon source readings; PieFed's day-one cap; `comment.restored`; the dormancy hook; a cap on rows one burst queues.
