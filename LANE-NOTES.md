# Lane FED-C notes (wave 3)

Branch `mvp-w3-fed-c`, worktree `/Users/admin/Projects/feddit-mvp-w3-fed-c`, `lane.sh` name `fed_c` (port 18325). Status: step 1 done; step 2 (settings and site-ban Block) pending the `w3-groundwork` tag, which did not exist when I finished step 1.

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

Pending (step 2, needs `w3-groundwork`): `deliverDue` honouring the `delivery.enabled` site setting, and the outbound site-ban `Block` from `mod.ban` events with `communityId: null`, skipping inboxes where `deliveryBlocked` is true.

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

- Step 2, pending: `deliverDue` skipping when `delivery.enabled` is false (`delivery/run.ts`), and the site-ban `Block` (`ban()` in `relay/moderation.ts`, target the instance actor at `/`, sent to `peerInboxes(t.db)` minus inboxes where `deliveryBlocked`, same shape as `accountDeletion`; the `mod.ban` branch in `relay/consumer.ts:onModeration` currently returns early for `communityId === null`). To start it: `git merge w3-groundwork`, delete `node_modules`, reinstall.
- `actors/serve.ts` (not in this lane's write set) serves a post's Page with its Mention tags but without the mentioned people in `cc`, so the document fetched at its id differs slightly from the one we sent. Harmless for Lemmy and Mastodon; REM or the lane that owns `actors/serve.ts` could add `withCc` there.
- A Mastodon-like follower cannot see a restored post: Mastodon records a Tombstone for a deleted status and refuses a later Create. Decision 3 of `decisions.md` accepted this.
- PieFed's day-one cap, `comment.restored`, the dormancy hook and the cap on rows one burst queues remain as listed in the brief, section 7 ("Waits, FED-C later").
- Source readings of Mastodon in the brief are from `main` on 2026-11-09 and unverified against a live server until LAB runs its scenario.
