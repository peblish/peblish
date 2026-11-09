# Lane COMM notes (wave 3: community page, community form, NSFW gate)

Branch `mvp-w3-comm`, worktree `/Users/admin/Projects/feddit-mvp-w3-comm`, from tag `w3-groundwork` (35fbc62), `lane.sh` name `comm`, port 18324. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`, `s/` `packages/schema/src`.

## 1. What landed

| Deliverable                                                                                                                                                                                                                  | Where                                                                               | Proof                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declareAge` / `declareAgeAs` (action `age.declare`, event `age.declared`, no consumer)                                                                                                                                      | `c/communities/age.ts`, `c/authz/actions/communities.ts`, `s/events/communities.ts` | `c/communities/age.test.ts` (under 16 writes nothing, null age, 16 writes one row and one event, a repeat writes nothing)                                                                                                              |
| Hide NSFW as two per-browser cookies: codec, `NsfwChoice`, `hideNsfw`, `showNsfw`                                                                                                                                            | `c/communities/gate.ts`                                                             | `gate.test.ts` (garbage, 11 ids, newest ten kept, flags)                                                                                                                                                                               |
| `Gate` is `none \| sign-in \| age \| hidden`; `readPost(id, viewer, q, nsfw = hide)`; `postViews` passes `showNsfw`                                                                                                          | `c/posts/read.ts`                                                                   | `c/posts/read.test.ts` (exact gate for post, community and both flags; signed out, undeclared, declared; `always`; `once` with and without the community; `hidden` withholds title, url, thumbnail, excerpt and body; feeds unchanged) |
| `findCommunityId`, `communityGate`, `readCommunityPage` (counts held here, `createdAt`, `fetchedAt`, `home`, every moderator row as `local \| fresh \| stale \| unknown`, `followState`, `banned`, `canPost`, `canModerate`) | `c/communities/read.ts`, `c/communities/page.ts`                                    | `c/communities/page.test.ts` (local, restricted, banned, remote with all moderator states, deleted, removed, unknown)                                                                                                                  |
| `CommunityInput.discoverable` / `.indexable`; `updateCommunity` logs `details.fields` (only fields whose stored value changed)                                                                                               | `c/communities/{input,create,update}.ts`                                            | `update.test.ts` "discoverable and indexable..." ; `posting-restriction.test.ts` passes                                                                                                                                                |
| `GateNotice` replaces the community page, the post page and the permalink; payload is the handle, the page to come back to and the state                                                                                     | `w/routes/c/-ui/gate.tsx`, `w/routes/c/-gate.ts`, `w/routes/post/**`                | `e2e/communities` NSFW gate block (6 cases); `e2e/post`                                                                                                                                                                                |
| `POST /c/<handle>` intents `follow`, `unfollow`, `declare`, `nsfw-once`, `nsfw-always`, `nsfw-hide`                                                                                                                          | `w/routes/c/-intents.ts`, `w/routes/c/$handle/index.tsx`                            | `e2e/communities`                                                                                                                                                                                                                      |
| Community page (two columns, strip, Join / Joined / Pending, New post, Mod tools, slots rendered, 404 with the `/resolve` link, `noindex`)                                                                                   | `w/routes/c/-ui/community-page.tsx`, `-load.ts`, `-format.ts`, `$handle/index.tsx`  | `e2e/communities` community page block; axe in en-US and de-DE                                                                                                                                                                         |
| Community form (`/c/new`, `/c/<handle>/edit`)                                                                                                                                                                                | `w/routes/c/{new.tsx,-form*.ts,-ui/community-form.tsx,$handle/edit.tsx}`            | `-form.test.ts`; `e2e/communities` form block                                                                                                                                                                                          |
| Seeds                                                                                                                                                                                                                        | `c/testing/seed-comm.ts` (`e2e`, `declared <name>`)                                 | e2e                                                                                                                                                                                                                                    |

## 2. Commits

| Commit  | Change                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ |
| 7c33c22 | Core gate: `declareAge`, event, cookie codec, `Gate` and `readPost`, web consumers compile |
| 6fea2b0 | Read models, `discoverable`/`indexable`, `details.fields`, `seed-comm.ts`                  |
| 25c2f58 | Web gate: `GateNotice`, intents, post and permalink pages, `e2e/post` updated              |
| 8219b58 | Community page                                                                             |
| fc1da28 | Community form                                                                             |
| (last)  | This file                                                                                  |

## 3. Verification

- `pnpm typecheck`, `pnpm lint` (boundaries, oxlint, prettier) green on every commit.
- `pnpm check`, final run: 2,106 passed, 3 skipped, 14 failed. None is COMM's:
  - 7 are the two `backfill.test.ts` files (5 core, 2 federation). They hard-code `now = 2026-11-09T12:00:00Z` and queue rows at the database's `now()`, so they fail once the wall clock passes that instant. Checked on a clean `w3-groundwork` worktree: the same 7 fail there.
  - 7 are `outbox/worker.test.ts` (6) and `authz/moderators-cache.test.ts` (1): timing tests that fail under the machine's load (load average 20 to 35) and pass alone; the same file failed 4 cases on the clean worktree in one of two back-to-back runs while my branch passed twice.
- `pnpm build && pnpm e2e` on 18324: 239 passed, 1 skipped (GW3 left it at 218 passed, 1 skipped; +18 `e2e/communities`, +3 payload entries).
- New unit tests: core `age`, `gate`, `page`, one `update` case, and the gate cases in `posts/read.test.ts` that replace the blur case; web `-form.test.ts` (3).
- The tests ran on the default migrations (no table is added, no scratch migration needed; nothing under `packages/core/drizzle/` changed).

## 4. Decisions and deviations

1. Gate age is the account minimum (16, decisions COMM 7); Under 16 reuses sign-up's `peblish.age_gate` cookie (24 h), so that browser cannot sign up for 24 h either.
2. Where the brief left it open: `communityGate` (the whole-community decision) sits in `c/communities/page.ts` beside `readCommunityPage`, and `findCommunityId` in `read.ts`. `CommunityDetail` gained `discoverable` and `indexable` (the page is `noindex` when `indexable` is false; the edit form prefills them).
3. Gate payload (`kind: 'gate'`): `subject`, `state` (`sign-in`, `age`, `under-16`, `hidden`), the community handle (as typed in the address on a community page; the post's community handle on a post or permalink) and the path to return to. A gated post names its community's handle: the forms post there and Show once is per community. 200, `x-robots-tag: noindex`, `<meta robots noindex>`, `private, no-store` (e2e asserts all three and that the seeded secret is nowhere in the HTML).
4. **Deviation**: the post page's slot condition `withheld !== 'gate'` (GW3 notes) is gone, because the gate now replaces the page; the slots render for any signed-in viewer of a post that is shown. A flagged post's flag line is a `div`, not a `p`, to hold the Hide NSFW form.
5. **Deviation, outside the listed lines**: `w/routes/post/$id/comments/$commentId.tsx` (head, search `error`, a prop) changed, because the permalink data is now `kind: 'gate' | 'thread'`; and `PermalinkPage` lost `commentId` from use (kept in the props type).
6. **404 and 403 status on `/c/<x>`**: `server/federation.ts` (root's) copies a UI response to add `Vary: Accept` on `/`, `/u/<x>` and `/c/<x>`, and the copy reports 200 where the router said 404 or 403 (instrumented: `editable(response).status` reads 404, and 200 after `headers.append`). Measured on the built server: `/c/nobody` and `/u/nobody` were 200. COMM's pages say `Vary: Accept` themselves (`varyByAccept()` in `c/-gate.ts`, called by the community and `/c/new` loaders), so the copy is skipped and 404/403 are real; `/c/<handle>/edit` is not a negotiated path. `/u/<x>` (E1) still has the bug; see section 5.
7. Unknown, deleted or removed community: the route throws `notFound({ data })` and has its own `notFoundComponent` (status 404 with the `Vary` fix). An unknown remote handle links to `/resolve?q=!name@host` (DISC's `q`, a plain `<a>` because that route is not in this branch).
8. Icon and banner rows are always shown disabled; the tag says "uploads off" while `uploads.enabled` is false (nothing else is specified). `postingWarning` is not in the mock: the form leaves it as stored on edit and null on create.
9. Rules on the form are titles only; each rule's text rides in a hidden `rules.<i>.body` and goes back unchanged. The list shows one empty row so a rule can be added without JavaScript; reorder and remove need JavaScript. Count text is "n of 15" (the mock says 10).
10. Hydrated Join / Leave / Cancel post by fetch and call `router.invalidate()`; signed out, the same form is a 303 to sign-in with `redirect` back. No "Refresh now" (decision 4), no feed strip (6), no Settings, Content page (5: the toggle is on the gate and flagged pages; the gate note says so).
11. Mod tools lists Reports (`reportQueuePath(handle)`), Modlog (`modlogPath(handle)`), Edit (local only; a remote copy says "Local actions only on this copy") and the MODF `moderate` slot. No open-report count is shown beside Reports (REP's `openReportCount` is per viewer, not per community). "Banned people" and "Moderators" are not there (decision 8).
12. `readPost` withholds a flagged post from a moderator or admin who has not declared 16+ or has Hide NSFW on, like anyone else.
13. The form's name field has no live availability check; `name.taken`, `name.reserved` and `name.invalid` come from the server (and `name.invalid` also from the browser through `ACTOR_NAME`).
14. Member-facing copy for the form refusal names the reason (`error.auth.admin_required`, `error.mod.moderator_required`, `error.community.not_local`), not a generic 403 text.

## 5. Requests to root

- `packages/web/src/server/federation.ts` (`withFederation`): the `Vary: Accept` copy loses a 404 or 403 on `/c/<x>`, `/u/<x>` and `/`. Reproduce on the built server: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/u/nobody` answers 200. COMM works around it for its own pages; a root fix (add the header to a `Headers` object first, then build the response with the original status) would cover E1's profile, which will otherwise answer 200 for an unknown person. Once it is fixed, `varyByAccept()` can go.
- `e2e/payload/routes.ts`: appended `/c/$handle/` (seeded community), `/c/new` (admin) and `/c/$handle/edit` (admin, seeded community); the budget spec passes with them. Root resolves the append conflicts.
- `packages/core/src/remote/backfill.test.ts` and `packages/federation/src/backfill/backfill.test.ts` hard-code `2026-11-09T12:00:00Z` as "now" and fail on any clock after that; they fail on the groundwork tag too.
- No settings key, throttle scope or migration is needed.

## 6. Requests to other lanes, through root

- DISC: filter the directory by `discoverable`; admins see "New community" linking `newCommunityPath`; Join posts `intent=follow` (or `unfollow`) to `/c/<handle>` with a `redirect` path, or calls `followAs`; `/resolve` reads `?q=` (the community page links `/resolve?q=!name@host` for an unknown remote handle).
- MODF and REP: `/modlog` and `/admin/reports` read a `community` search parameter (the handle); the page links `modlogPath(handle)` and `reportQueuePath(handle)`.
- E1: a blocked community's page should show a notice with Unblock; the community `block` slot renders in the header for a signed-in viewer. Fill `w/routes/c/-ui/actions/block.tsx` (props `CommunityActionProps`).
- MODF: the `moderate` slot renders inside the Mod tools `<details>`, for owners, moderators and admins.

## 7. Dependencies added

None.

## 8. For later lanes

- To gate another page: ask `communityGate` / `readPost` with `requestNsfw()` (`w/routes/c/-gate.ts`), return `gateData({ subject, gate, handle, back })` (sets noindex) and render `<GateNotice data={data} error={error} />`; link `c/-ui/gate.css`. The forms post to `/c/<handle>` with a `redirect` path.
- `POST /c/<handle>` answers 303 or JSON (`Accept: application/json`): `{ ok, redirect }` or `{ error }`; `reply` in `w/routes/c/-reply.ts`.
- `readCommunityPage({ id }, viewer, q, hooks)` is one fixed handful of queries; moderator `state` says whether a row grants anything (`local` and `fresh` do).
- The form's field check is one function (`problemsOf`, `w/routes/c/-form.ts`) used by the browser and the server; copy keys are `form.*` in `communities.json`.
- `seed-comm.ts e2e` prints people, communities (open, restricted, empty, quiet, two NSFW, one remote with fresh, stale and unknown moderators) and posts; every flagged thing carries `secret`.

## 9. Left open and risks

- Reports count and a "Refresh now" are not shown (see 4.10, 4.11).
- Icon and banner upload, live name availability, a character counter and keyboard shortcuts on the rules list are not built.
- The `Vary: Accept` workaround is the only thing keeping 404/403 real on `/c/<x>` until root fixes `withFederation`.
- Imported accounts have no `age_declarations` row: they see the declare form the first time they open an NSFW page.
- `pnpm check` cannot be fully green today for the reasons in section 3; none comes from this lane.
