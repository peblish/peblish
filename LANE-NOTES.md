# Lane E2: inbox with mentions

Branch `mvp-w3-e2` from `w3-groundwork` (35fbc62), with E1's first commit (`e44083d`, the block tables and predicate) merged for the block filter. Port 18316, database `peblish_e2`. Paths: `c/` is `packages/core/src`, `w/` is `packages/web/src`, `s/` is `packages/schema/src`.

## 1. What landed

| Deliverable                                                                                                                                              | Where                                                                        | Proof                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table `notifications` (unique `(recipient_id, ref_id)`, indexes `notifications_recipient_id` and partial `notifications_unread`)                         | `c/notifications/tables.ts`                                                  | `notifications/mutations.test.ts`, `read.test.ts` (plan)                                                                                                                       |
| Events `notification.created`, `notification.read`, `notification.purged`; refusal `notification.not_yours`                                              | `s/{events,refusals}/notifications.ts`                                       | registry tests                                                                                                                                                                 |
| Four policies and four mutations (`notification.create`, `.read`, `.read_all`, `.purge`), web helpers `markNotificationAs`, `markAllNotificationsReadAs` | `c/authz/actions/notifications.ts`, `c/notifications/{mutations,service}.ts` | test 5: `mutations.test.ts` (policy table with exact reasons, row and event in one transaction by xmin, a duplicate writes neither, mark actions touch only the caller's rows) |
| Mention scanner `findMentioned(db, { bodyMd, raw, authorId })`                                                                                           | `c/mentions/scan.ts`                                                         | test 1: `scan.test.ts`                                                                                                                                                         |
| Consumer `notifications.create`                                                                                                                          | `c/notifications/consumer.ts`                                                | tests 2, 3, 4: `consumer.test.ts`                                                                                                                                              |
| Block seam wired to E1's predicate                                                                                                                       | `c/notifications/blocked.ts`                                                 | test 4 (also fails when the predicate is made false)                                                                                                                           |
| `unreadCount` (stub body replaced, signature kept) and `readInbox`                                                                                       | `c/notifications/{unread,read,view}.ts`                                      | tests 6, 7: `read.test.ts` (filters, cursor, withheld text, trust rule, closed communities, cap, plan on `notifications_unread`, p95 under 50 ms over 20,000 rows)             |
| `/notifications` page, form, strings (`en`, `de`)                                                                                                        | `w/routes/notifications/**`, `w/i18n/notifications.json`                     | test 8: `e2e/notifications/notifications.spec.ts` (11 cases) and `-search.test.ts`                                                                                             |
| Seeds                                                                                                                                                    | `c/testing/seed-e2.ts`                                                       | `seedInboxWorld`, `drainNotices` (the real `processBatch`), `say`, `remoteSay`, `seedModlog`, `seedNotice`, CLI `e2e`                                                          |
| Payload route                                                                                                                                            | `e2e/payload/routes.ts`                                                      | `/notifications/` as `admin: true`, like GW3's `/settings/blocks/`                                                                                                             |

The consumer's rules, as built: a reply on `comment.created` goes to the parent comment's author, or the post's author for a top-level comment; a mention (full `@name@host` or a `Mention` tag with an https `href`) on all four content events; one notice per person per cause, a mention beating a reply; never to the author, a recipient who is not a live local Person, a deleted or removed object, an object published more than 7 days ago, or a recipient who blocks the author, their instance, the community or the community's instance. `mod.remove` goes to the target's local author unless they are the moderator, kind `mod_remove` or `mod_restore`, `ref_id` the modlog id. `mod.ban` goes to `targetActorId`, kind `ban` or `unban`. Neither is age-limited or block-filtered. `actor.deleted` for a local Person purges their notices. Every write is authorized as the `scheduled` system job and skipped on a refusal.

## 2. Commits

```
b09c020 Add the notifications table, events, policies and mutations
d74516b Add the mention scanner for local people
eb9ee87 Add the notifications consumer for replies, mentions, removals and bans
a867f81 Add the inbox read model and the capped unread count
df8526a Add the inbox page, its form, strings and end-to-end tests
2811a87 Merge commit 'e44083d' into mvp-w3-e2   (E1's predicate commit only)
0a4f68e Wire E1's block predicate into notice creation, the list and the unread count
```

The head, with this file and the last test and spec tweaks, is in the final report.

## 3. Verification

- Scratch migration (`common.md` method): `0008_wave_3_e2.sql` in `/private/tmp/claude-501/-Users-admin-Projects-feddit/68fae2dc-24c3-4150-a10a-6de89e6e702a/scratchpad/e2/drizzle/`. After the merge of E1's commit it holds `notifications` and E1's three block tables. Nothing under `packages/core/drizzle/` changed.
- `pnpm check` (last full run, clean tree except these notes): typecheck, lint, boundaries and format pass; tests 2,143 passed, 9 failed, 3 skipped. None of the 9 is this lane's, and all 9 fail or flake without it:
  - `core/remote/backfill.test.ts` (5) and `federation/backfill/backfill.test.ts` (2): **a time bomb, also failing on `w3-groundwork` with none of my commits.** The tests pin `now` to `2026-11-09T12:00:00Z` while the queue rows take the database clock, so they fail from 12:00 UTC on 2026-11-09 on. They need a `now` taken from the clock (FED lane; for root).
  - `db/migrate.test.ts` (1) and `outbox/worker.test.ts` (1): 5 s timing tests. The shared Postgres was busy with many lanes (load average above 40), and the outbox horizon (`pg_snapshot_xmin`) is cluster-wide, so another lane's open transaction delays every worker test. Each passed alone, three runs in a row.
  - Earlier full runs also flaked once on `federation/inbound/receive.test.ts` "too much waiting in inbox_raw" (5 s), which passed alone.
  - My own consumer tests wait for the same horizon through `drainNotices`; they set a 60 s timeout for it.
- `pnpm build && pnpm e2e` on port 18316: see the final report. My 11 cases pass. Unrelated failures seen across runs, none constant: `comments.spec.ts` "500-comment thread ... under 200 ms" (best of five 222 ms against 200 under load), `composer.spec.ts` "what Preview shows is what is published" once (remote image rendered as a link in the preview and as a proxied image when published; it passed in the other runs), `shell.spec.ts` "the sidebar holds the feeds" once (`main` not found yet). The first item below is a real defect that my lane exposes.

## 4. Decisions and deviations

1. Deviation: `notifications.modlog_id` has no foreign key (the brief says `set null` on delete). A foreign key into the append-only modlog makes `TRUNCATE modlog` fail on the constraint before the guard trigger, and `db/spine.test.ts` expects the guard's error. Modlog rows are never deleted, so a plain column loses nothing.
2. Deviation: no `route.tsx` layout. `/notifications` is one page route that carries `privateResponses` itself, as `/submit/` does. A layout above it would be a second file route to list under `notPages` in the payload inventory for no gain.
3. The block predicate E1 built is `actorBlockedBy(viewerId: Uuid, actor)` (a person, directly or through their instance), `blockedAmong` and `blockOf`, not the `blockedBy({ viewerId, actorId, communityId })` of the brief. `c/notifications/blocked.ts` composes `actorBlockedBy` with a community block and an instance block of the community, taking the viewer as a value (the viewer is always the recipient). The note on the columns in `blocked.ts` matters: a Drizzle column interpolated into those sub-selects loses its table name and compares a block row's own column with itself, so the list and count pass the notice's columns written out in full.
4. The unread count and the badge also count unread notices in a closed (deleted or removed) community, which the list omits; the brief's count has no join, to stay at 100 index probes. Mark all read clears them.
5. The mark forms are not rate limited: a throttle scope is root's (`identity/throttle.ts`). A request: add scope `notification` if wanted; the form handler then calls `attempt('notification', { id })` the way `routes/post/$id/comments/-form.ts` does.
6. Decisions.md E2 picks followed as written: only `@name@host` mentions, removal and ban notices ignore blocks, job `scheduled`, 7-day window, `startAt: 'beginning'`, the mock deviations, the purge, the badge refresh rule (document load, mark actions, `router.invalidate()`).
7. Excerpts are made in core (`readInbox`): our Markdown through `renderMarkdown`, a peer's HTML through `sanitizeRemoteHtml`, 200 characters, plain text. The page clamps to two lines. A notice about content shows the word instead (sensitive first, then removed or deleted) and never the text or, for sensitive content, the post title.
8. A notice's modlog entry is read as `staff` audience so the affected person sees the reason; the page links `/modlog/<id>` only for a public entry. The reason follows `readModlog`'s trust rule (an untrusted instance gives "Reason: not shown ...").
9. An edit that adds a mention of the parent comment's author, who already holds a `reply` for that comment, changes nothing: one notice per cause, so it stays a `reply`. A mention of anyone else adds one row.
10. `comment.created` for a reply under a removed or deleted post still notifies the parent's author; only the object's own state is checked at creation. The read model hides the text at read time.
11. The title is `(N) Inbox · <site>` (`(99+)` at the cap); an unread notice has a coloured edge and hidden "Unread" text.
12. e2e: the shared sidebar axe defect below made the "every kind" case use a local axe helper that leaves out only the sidebar's labelled link (`expectAccessibleBesidesBadge`). Once root fixes the sidebar it can become `expectAccessible`.
13. e2e seed: `drainNotices` waits until the cursor has passed every outbox row (up to 90 s) rather than for a quiet batch, because the horizon lags on a busy server. The spec's `beforeAll` sets a 120 s timeout for it. The consumer runs over the whole lane outbox, so it writes notices for other specs' users: that is what exposed the sidebar defect in other lanes' specs.

## 5. Requests to root

1. **Shell, must fix before the wave merges.** `w/shell/sidebar.tsx` (GW3) gives the Inbox link `aria-label="Inbox, 11 unread"` while its visible text is "Inbox" plus an `aria-hidden` badge "11". axe reports `label-content-name-mismatch` (WCAG 2.5.3) on `a[href$="notifications"]` on every page a signed-in person with unread notices opens. GW3's e2e never saw it because the count was always 0. With E2 merged, any spec whose user receives a notice and runs axe fails (it did: `comments.spec.ts` "replies to a comment through the docked bar"). The same pattern is on the Moderation queue link (`you.queueOpen`), which REP will hit. Fix for both links: drop the `aria-label` and the `aria-hidden`, and put the words in the badge as hidden text, `<b className="pb-count">{count}<span className="pb-sr"> {t('shell', 'you.unread')}</span></b>` (a visually hidden class and one string, `you.unread` "unread" and `queue.open` "open"), so the accessible name is "Inbox 11 unread". I checked the minimal form locally (no aria-label, badge not hidden): the full suite's other specs then passed, with the one e2e assertion of mine on the name loosened to `/^Inbox\b.*\b11\b/` so it accepts the fixed form. The edit is not in this branch.
2. **Migration.** The `notifications` table, for `0008`: scratch SQL at the path in section 3 (it also holds E1's block tables from the merged commit; take only the `notifications` statements, or generate once for the wave). No foreign key on `modlog_id` (decision 1).
3. **Payload route**: `{ route: '/notifications/', path: '/notifications', admin: true }` is already appended by me in `e2e/payload/routes.ts`, as the launch rules allow.
4. `phase-1.md` "Visible launch gaps": a bare `@name` is not a mention at launch (decisions.md E2 1).
5. Optional: throttle scope `notification` (decision 5).
6. Cutover: the consumer starts at `'beginning'`. Replies and mentions are limited to the last 7 days, but removal and ban notices are not age-limited. If the outbox holds history at cutover (imported or replayed `mod.remove` and `mod.ban` events for local people), switch the consumer to `'now'` first, as decisions.md E2 6 allows.

## 6. Requests to other lanes, through root

- MODF: `/modlog/<id>` must show an entry to the person it affects even when it is not public; E2 links only public entries. The page is a plain link to `/modlog/<id>` (no helper in `shell/paths.ts`).
- FED-C: for outbound mentions, as decisions.md E2 says. Nothing new from this lane.
- E1: `c/notifications/blocked.ts` imports `blocks/predicate.ts` (`actorBlockedBy`) and `blocks/tables.ts` (`communityBlocks`, `instanceBlocks`); a rename there breaks it at typecheck.

## 7. Dependencies added

None.

## 8. For later lanes

- A new notice kind: add it to `notificationKinds` (`c/notifications/view.ts`) and to the literal union in `s/events/notifications.ts` (the check constraint in the table follows `notificationKinds`, so root regenerates the migration), a case in `consumer.ts`, a `filterKinds` group, and `type.<kind>` and `verb.<kind>.*` strings in both languages (`-search.test.ts` checks the type labels).
- Tests that need an inbox: `seedInboxWorld()` (`seedPostWorld` plus the instance actor), `say` and `remoteSay` (the real comment actions), `drainNotices()` (the real `processBatch`), `noticesOf`, `kindsOf`, `seedNotice`, `seedModlog`. With E1's `seedBlock` for blocks.
- `readInbox(viewer, { filter, cursor, limit }, q?)` returns `{ items, next, unread, unreadByGroup }`; the item type is browser-safe in `view.ts`. `unreadCount(viewerId | null, q?)` is what the shell calls.
- A page that wants the notice count must not call `unreadCount` per row.

## 9. Left open and risks

- Not built (out of scope in the brief): autocomplete, remote-handle resolve, `!community` notices, new-moderator, follow, report, invite and answer notices, email and push, settings, DMs, a retention job, a throttle on mention floods.
- A remote person is not told of a mention until FED-C delivers the tag to their inbox, and a local person mentioned by a peer who does not deliver to us is never told.
- The closed-community difference between list and count (decision 4).
- The e2e `beforeAll` depends on the cluster's outbox horizon; on a very busy machine it can take a minute.
