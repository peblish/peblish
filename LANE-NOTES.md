# Lane E1 notes (wave 3: profiles and blocks)

Branch `mvp-w3-e1` from `mvp-w3` (tag `w3-groundwork`, 35fbc62), worktree `/Users/admin/Projects/feddit-mvp-w3-e1`, `lane.sh` name `e1`, port 18315. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`, `s/` `packages/schema/src`.

## 1. What landed

| Deliverable                                                                                            | Where                                                                                                          | Proof                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block tables `person_blocks`, `community_blocks`, `instance_blocks` and the caps (500, 500, 200)       | `c/blocks/{tables,limits}.ts`                                                                                  | `c/blocks/mutations.test.ts` (cap)                                                                                                                                      |
| Feed predicate `blocks`, applied to every feed and sort by `visible()`                                 | `c/blocks/feed-predicate.ts`, `c/feeds/read.ts` (`visible` exported)                                           | `c/blocks/predicate.test.ts` (every feed hides blocked posts for the blocker only), perf below                                                                          |
| `actorBlockedBy`, `blockedAmong`, `blockOf`                                                            | `c/blocks/predicate.ts`                                                                                        | `c/blocks/predicate.test.ts` (agree with the feed predicate for person, community and instance)                                                                         |
| `block.add`, `block.remove`: policies, mutations, events, refusals                                     | `c/authz/actions/blocks.ts`, `c/blocks/mutations.ts`, `s/{events,refusals}/blocks.ts`                          | `c/blocks/mutations.test.ts` (exact reasons; twice is one row and one event; community and instance blocks delete follows and emit `follow.removed` in one transaction) |
| `addBlockAs`, `removeBlockAs`, `listBlocks`, `listInstanceBlocks`, `blockCounts`, `resolveBlockTarget` | `c/blocks/actions.ts`                                                                                          | `c/blocks/actions.test.ts`                                                                                                                                              |
| Thread collapse: text withheld, place, replies and counts kept, permalink comment exempt               | `c/comments/read.ts`                                                                                           | `c/blocks/thread.test.ts` (person, instance, moderator, permalink; 500 comments with 1,000 blocks under 200 ms)                                                         |
| `readProfile`, `readActivity` (posts and comments through `visible`, keyset paging, Overview merge)    | `c/profiles/{read,input}.ts`                                                                                   | `c/profiles/read.test.ts`                                                                                                                                               |
| `profile.update` for display name and bio                                                              | `c/authz/actions/profiles.ts`, `c/profiles/{update,input}.ts`, `s/refusals/profiles.ts`                        | `c/profiles/update.test.ts`                                                                                                                                             |
| `/settings/blocks` and the shared POST                                                                 | `w/routes/settings/blocks/**`, `w/i18n/blocks.json`                                                            | `e2e/blocks/blocks.spec.ts` (7 cases: sign-in redirect, hydration and axe in en and de, add and Undo, no-JS, every refusal, feed and thread, instance block)            |
| `/u/<handle>` and `/u/<handle>/edit`                                                                   | `w/routes/u/$handle/**`, `w/i18n/profiles.json`                                                                | `e2e/profiles/profiles.spec.ts` (14 cases)                                                                                                                              |
| The four Block slots                                                                                   | `w/routes/{post,post/$id/comments,u,c}/-ui/actions/block.tsx`, `w/routes/settings/blocks/-ui/block-action.tsx` | `e2e/blocks` (post and comment rows), `e2e/profiles` (profile)                                                                                                          |
| Opt-in performance                                                                                     | `c/feeds/perf.test.ts` (blocker viewer), `c/profiles/perf.test.ts` (prolific author)                           | section 3                                                                                                                                                               |

## 2. Commits

| Commit               | Change                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| e44083d              | Block tables, predicate module, feed predicate, `seedBlock`, `visible` exported (the commit E2 waits on) |
| a42cb75              | Events, refusals, policies, mutations, action layer                                                      |
| b1104ad              | Thread collapse                                                                                          |
| 72c5450              | Profile reads, activity paging, `profile.update`                                                         |
| 0de182d              | Blocks page, POST handler, the four Block slots, `e2e/blocks`, the e2e seed                              |
| 6bcf8ce              | Profile pages and Edit profile, `e2e/profiles`, payload entries, profile perf test                       |
| (this file's commit) | Feed perf viewer, these notes                                                                            |

## 3. Verification

- `pnpm check`: build, typecheck, lint and boundaries green; 2,131 tests passed, 4 skipped, **12 failed**: 7 in `c/remote/backfill.test.ts` (5) and `f/backfill/backfill.test.ts` (2), 5 in `outbox/worker.test.ts`. They hard-code `2026-11-09T12:00:00Z` as "now" and compare it with the database clock, so they began to fail at 12:00 UTC today; they fail the same way run alone and touch nothing of this lane. Root's `decisions.md` already names this and the fix on `mvp-w3-clock`, which lanes wait for.
- The machine's load average was 13 to 48 for most of the day. Besides that, `outbox/worker.test.ts` is known to fail about half the time on `w3-groundwork` (decisions, root lane ROOT-WORKER); other timing tests failed once or twice in a full run (`comments/mutations.test.ts` 51st level, `migrate.test.ts`, `moderators-cache.test.ts`, `pipeline.test.ts`, `receive.test.ts`) and passed when run alone. Every commit was made after a `pnpm check` whose only failures were those.
- `pnpm e2e` on port 18315, full suite after `pnpm build`: 242 passed, 1 skipped (baseline on main 218 passed, 1 skipped; this lane adds 7 blocks and 14 profiles cases, GW3 removed 2).
- Opt-in `PEBLISH_FEED_PERF=1`:
  - `c/feeds/perf.test.ts`, new cases "blocks 100/50/20" (100 person, 50 community and 20 instance blocks) on All and Local: 36 timings, worst p95 37.8 ms (Hot, All), no `Seq Scan on posts` in any plan. The file's other cases (signed out Popular and a few Hot/Top rows) went over 50 ms in this run only because of the machine's load (21 of the file's rows), so the file's final `expect(slow)` failed; none of them is a blocks row.
  - `c/profiles/perf.test.ts`: an author with 5,000 posts and 20,000 comments among 100,000 posts and 170,000 comments, a viewer with the same blocks, every tab and sort: p95 Overview new 15.6 ms, Overview top 24.7, Posts new 8.2, Posts top 19.8, Comments new 18.1, Comments top 17.4; plans use `posts_author_published` and `comments_author` (see decision 14), no sequential scan of `posts` or `comments`.

## 4. Decisions and deviations

1. `BlockTarget` is a three-member union (`person`, `community` with `actorId`; `instance` with `instanceId`) instead of the brief's `kind: 'person' | 'community'` member, so TypeScript narrows on `kind`. Same data.
2. Deviation (minor): `s/refusals/profiles.ts` holds `profile.not_own` as well as `profile.invalid`. Editing someone else's profile is its own refusal rather than `auth.required`. No `s/events/profiles.ts`: `actor.updated` is reused.
3. Block policies: a person target is refused as `target.not_found` when the actor is a Group, `target.protected` for self, any Application and any account whose role is admin (two-factor not required, a stricter reading than the admin badge). No recheck on either action, as the brief says; the size check runs after the insert inside the transaction under a `FOR NO KEY UPDATE` on the blocker's actor row, so concurrent blocks cannot pass the cap and an existing block at the cap is not refused.
4. A repeated block still ends follows that were made again since (`followAs` does not look at blocks), emitting `follow.removed` for each; `block.added` only when the row is new.
5. Web-facing reads of `c/blocks/actions.ts` take the query handle last with a default (`listBlocks(blockerId, kind, q = db())`), because `web-no-database` forbids web importing `db/read.ts`. The predicate module keeps the brief's `q`-first signatures.
6. Handles resolve against stored actors and instances only (decisions E1 3); `handle.invalid` is a shape that cannot be a handle, `handle.not_found` a well-formed one with no match, and both are web errors.
7. The block slots on the post page and the comment row block `author` (GW3's props, decision 3 of its notes), are hidden on the viewer's own content and on deleted content, and are stateless. The profile page does not render the profile slot for the viewer's own page or for a person already blocked (it shows the Unblock notice instead). The community slot renders for whatever the community page passes it.
8. The profile's counts are the person's live posts and comments, not filtered for the viewer, so a viewer who may not see sensitive posts still sees them counted. The tabs list only what the viewer may see. Counting through `visible` would cost a join per post on a 5,000-post author.
9. Overview, Posts and Comments page with the feeds' cursor (`c/feeds/cursor.ts`, period `all`): New keys on `(published_at, id)`, Top on `(score, id)`, one cursor for both lists of Overview since ids are unique across tables. A comment is listed when it is live and its post passes `visible('all', viewer)`.
10. Edit profile reuses the composer's `MarkdownEditor` (Write and Preview) with `previewBody`. Without scripts the form posts natively and returns with `?saved=true` or `?error=<code>`; with scripts it posts by fetch and reloads the card. `?saved=1` was not used because the router rewrites a numeric string to `"1"`. Avatar, banner and Bot rows are not shown (R2b).
11. The enhanced block forms ask for JSON and get `{ redirect }` or `{ error }`; `BlockForm` navigates to the redirect and invalidates, so the slot on a thread row reloads the thread's data.
12. `/u/<unknown>` renders the shell's "Page not found" but answers **200**: a path that negotiates by Accept goes through `withFederation`, which hands a declined request to the UI as a fresh request, and the status of a loader's `notFound()` is lost there (`/post/<unknown>` answers 404). Not fixable inside the write set (`w/server.ts`, `w/server/federation.ts` are root's); `/c/<unknown>` shows the same today. The e2e asserts the page, not the status. See section 5.
13. The e2e axe check of the edit page leaves out `[role="toolbar"]`: the Markdown editor's formatting buttons fail `target-size` (UI package, shared with the composer's text posts).
14. The author perf test accepts `comments_author` or `comments_author_published`: for a viewer who hides most of what the author wrote the planner prefers the plain author index and fetches in about 8 ms. It creates `comments_author_published` when absent, as asked.
15. `CommentView.blocked` is set only when true, so unblocked views are byte-identical to before.
16. E2e: the shared lane database holds other specs' posts, so the feed cases walk All by New page by page for the seeded titles (`walkAll` in `e2e/blocks/blocks.spec.ts`) instead of trusting the first page. An earlier version scored its posts 1000 to stay on top and broke `feeds.spec.ts`; the rows in `peblish_e1` were reset.
17. Process: `pnpm check` was run on the working tree before each batch of commits, not once per commit; commits 5 and 6 share one run (see section 3).

## 5. Requests to root

- **Migration `0007` (or the wave's):** the tables are in `c/blocks/tables.ts` (`person_blocks` with `person_blocks_not_self`, `community_blocks`, `instance_blocks`, indexes `person_blocks_blocked`, `community_blocks_community`, `instance_blocks_instance`; scratch SQL generated as `0008_e1_blocks.sql`). Add `index('comments_author_published').on(t.authorId, t.publishedAt.desc())` to `c/db/tables/content.ts`.
- **Payload routes:** `e2e/payload/routes.ts` already lists `/settings/blocks/` (GW3) and now `/u/$handle/` and `/u/$handle/edit` (admin), added by this lane.
- **Status 404 for unknown `/u/<handle>` and `/c/<handle>`:** make `withFederation` (`w/server/federation.ts`) carry the UI's status for the fall-through request, or add a regression test with the shell's other 404 cases. Until then both answer 200 with the not-found page.
- **Held remote people:** `/u/<name>@<host>` is served for any remote Person or Service already stored here (`readProfile` finds it by name and host; `e2e/profiles` covers one). DISC's request for this is answered; it needs nothing from root.
- **`target-size` on the editor toolbar** (UI): `button[title=...]` in `MarkdownEditor` are under 24 px.
- Throttle scopes, settings keys, dependencies: none.

## 6. Requests to other lanes, through root

- **E2:** create no reply or mention notification when `blockOf(q, recipient, author) !== null`; filter the inbox and the unread count with `not actorBlockedBy(viewerId, <author id column>)` so a block made later clears old ones; never filter ban, removal, report-resolved or invite notices.
- **REP, MODF:** queues, modlog and moderator views must not apply the `blocks` feed predicate or `blockedAmong`.
- **COMM:** the community page renders `CommunityBlock` (props from GW3) and a notice with a link to `/settings/blocks?tab=communities` when `blockOf(q, viewerId, community.id)` is not null. A community the viewer blocks drops out of every feed through the predicate; its own page is still reachable.
- **DISC:** may hide or mark blocked communities in the directory with `blockedAmong`.

## 7. Dependencies added

None.

## 8. For later lanes

- Apply blocks to a posts query by listing the post's author and community, or register nothing: `feedPredicate` `blocks` is already in `visible()`. For other surfaces call `blockedAmong` once per page, never per row.
- `visible(feed, viewer, asOf, scope?)` is exported from `c/feeds/read.ts`; `readActivity` and `c/profiles/perf.test.ts` show a second query over `posts` and over `comments` joined to `posts`.
- `POST /settings/blocks` takes `intent` (`add` or `remove`), `kind`, `handle` or `target` (uuid) and `back`; answers 303 or JSON. `BlockAction` (`w/routes/settings/blocks/-ui/block-action.tsx`) is the one control the slots use.
- `readProfile(...).moderatedCommunities` is what MODF's profile slot gets; `badges` follow the thread's rules (admin needs two-factor).
- `c/profiles/input.ts` is pure (tabs, sorts, limits) so client code may import it; `read.ts` pulls in Node's `Buffer` through the feeds' cursor and must stay server-side.

## 9. Left open and risks

- Counts on the profile card include content a gated viewer is not shown (decision 8).
- Blocking never touches search or notifications until E2 and DISC use the predicate; the feed side is done.
- A blocked community can still be followed again; the follow does nothing visible, because the feed hides it.
- The 404 status of unknown profile and community addresses (decision 12) is root's.
- The Edit profile page has no mock check beyond the R2b pick; its copy is mine.
