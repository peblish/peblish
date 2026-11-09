# Lane FX-WEB notes

Branch `mvp-w3-fx-web`, worktree `feddit-mvp-w3-fx-web`, cut from tag `w3-review` (96d94dd). `lane.sh` name `modf`, port 18320. The `peblish_modf` database was migrated from older files, so it was recreated with the command `lane.sh` printed.

## 1. What landed

| Finding                                                           | Commit  | Proving test                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S4 (W1): modlog titles and excerpts pass the post page gates      | 8528511 | `core/src/modlog/page.test.ts` "a title or excerpt passes the post page gates..." (fails before: 8 labels shown to a signed-out viewer, 2 after)                                                                                    |
| A4: the media proxy gates every redirect hop                      | a124294 | `web/src/routes/media/proxy/-handler.test.ts` "a redirect to a peer whose media is not allowed is a 404, and that host is never contacted"                                                                                          |
| W12: a malformed modlog `entry` is a 404                          | d6aefbd | `e2e/modlog/modlog.spec.ts` "an entry id that is not a uuid is a 404..." (before: 500 for 36 dashes)                                                                                                                                |
| W6: no `<form>` inside `<p>`                                      | c13213d | Hydration checks added to `e2e/profiles/profiles.spec.ts` (member's comments tab), `e2e/communities/communities.spec.ts` (Hide NSFW form) and `e2e/blocks/blocks.spec.ts` (the Undo note); before, all three logged React error 418 |
| W5: the profile ban select submits as `community`                 | cc7cb96 | `web/src/routes/modlog/-ui/content-moderate.test.tsx` (first-paint markup has one `community` field, the select)                                                                                                                    |
| W10 (Settings, Pages, Bans, Peers): denials answer 403            | bf0d4d8 | `e2e/admin/settings.serial.spec.ts` "...a member without the admin role is told no" checks 403 on `/admin/settings`, `/admin/pages`, `/admin/pages/rules/en`, `/admin/bans`, `/admin/peers` (before: 200)                           |
| W8: admin settings and pages specs are serial                     | 79a5550 | `pnpm exec playwright test --list`: before, 7 + 11 tests listed under `[chromium]`; after, under `[serial]`                                                                                                                         |
| W9: the serial project runs whether or not the parallel one fails | fd49022 | A throwaway failing parallel spec beside `admin/switches.serial.spec.ts` (not committed): before, "5 did not run", exit 1; after, `e2e: parallel run exited 1, serial run exited 0`, 5 serial passed, exit 1                        |

## 2. Commits

```
8528511 Gate modlog titles and excerpts as the post page does
a124294 Gate every redirect hop of the media proxy
d6aefbd Answer 404 for a malformed modlog entry id
c13213d Keep forms out of paragraphs on the profile, community and blocks pages
cc7cb96 Post the chosen community from the profile ban panel before hydration
bf0d4d8 Answer admin denials with 403 on Settings, Pages, Bans and Peers
79a5550 Run the admin settings and pages specs in the serial project
fd49022 Run the serial e2e specs whether or not the parallel ones fail
```

Plus the commit that adds this file.

## 3. Verification

- `pnpm check` before each commit: 2,509 to 2,511 passed, 7 skipped, 223 files at the end. Three runs each had one timing failure in code this lane does not touch, each passing alone right after: `reports/read.test.ts` "the budget" (5 s against a 50 ms budget, load average about 15) and twice `authz/moderators-cache.test.ts` "a mod.role event drops the pair..." (its poll waits below the cluster's oldest open transaction, which other lanes hold on the shared Postgres). No transaction was stuck in `peblish_modf_test`.
- `pnpm build && pnpm e2e` on fd49022, against a freshly recreated `peblish_modf`: the parallel run 321 passed, 1 skipped; the serial run 33 passed (354 passed, 1 skipped in all; the baseline put the same specs in one run). Earlier full runs on the same database: one had one failure, `e2e/comments/comments.spec.ts:320` (a 500-comment thread rendered in under 200 ms; best of 5 was 231 ms at a load average of 24). That spec passes alone (25 of 25). Another failed the composer specs, which stopped finding their seeded communities: after six e2e runs the database held 320 live local communities, past the 200 that `listLocalCommunities` returns, so new ones fell off the list. Recreating the database fixed it; CI starts from a fresh one.
- Schema changes: none. `git status` shows nothing under `packages/core/drizzle/`.

## 4. Decisions and deviations

1. S4: `describeTargets` builds post labels from `postViews` (the post page's rule for deleted, removed, a closed community and the age gate) and then applies the browser's Hide NSFW choice with `shows()`, as `readPost` does. A comment's excerpt needs its own row live (removed only for staff) and its post's title to pass. Nothing in `posts/read.ts` changed.
2. S4 changes two things staff saw before. A deleted post's title or comment's excerpt is withheld from staff too, as on the post page (a tombstone for everyone). The NSFW gate applies to staff as it does on the post page. Removed content still shows to the community's moderators and admins.
3. S4: `describeTargets` takes an optional `nsfw` (default Hide NSFW on) and needs `viewer.actorId` to find a signed-in viewer's age declaration and moderator rows. The loader always passes it; the test's viewers now carry it.
4. A4: the handler gates hops itself because `fetchProxiedImage` (`core/media/proxy.ts`) and `safeFetch` are outside this lane. It passes `fetchProxiedImage` a client that calls `safeFetch` with `maxRedirects: 0` per hop, keeps the caller's hop count and one overall deadline, and asks `mediaAllowed` about each Location host first. A refused hop answers 404 `no-store`, like a refused first host. The handler gains a `fetch` dependency for tests.
5. A4's test cannot run against the old handler without real network traffic (the old code ignored an injected client), so it proves the new behaviour only.
6. W10: the editor at `/admin/pages/<slug>/<language>` answers 403 too (it is under `admin/pages/**` and shows the same denial).
7. W9: `pnpm e2e` is now `node e2e/run.ts`, a new 30-line file beside the config. Deviation: the file is not in the listed write set; it is the smallest way to give `pnpm e2e` two runs while still passing file arguments. Arguments go to both runs with `--pass-with-no-tests`; arguments that name `--project` run once as given. `E2E_PHASE` gives each run its own `artifacts/test-results/<phase>` and, in CI, `artifacts/report/<phase>`, so the serial run does not wipe the parallel run's traces. A side effect: `pnpm e2e <file>` no longer pulls in the whole parallel project when a serial spec is named.
8. W9: the workflow is unchanged. CI's step already runs `pnpm e2e`, and the artifact upload covers `e2e/artifacts` with the new subfolders.
9. Deviation: the W12 and W6 proofs are e2e assertions in spec files outside the listed write set (`e2e/modlog/modlog.spec.ts`; `e2e/profiles`, `e2e/communities`, `e2e/blocks`). Each is a few added lines, next to the route it tests. Rendering those three pages in a unit test would have needed most of their loader data and routing mocked.
10. W6: each class (`prof-comment-actions`, `cm-address`, `blk-note`) sets its own margin, and no stylesheet (web, `@peblish/ui`, Mux) styles a bare `p`, so `div` renders the same.

## 5. Requests to root

- `README.md` line 109 still says serial specs run "after the rest; --project serial --no-deps runs them alone". Suggested: "`*.serial.spec.ts` (specs that save a shared site setting) run one at a time in a second run after the rest, whether or not it failed (e2e/run.ts); `pnpm e2e --project serial` runs them alone."
- Shared Postgres flakes: `authz/moderators-cache.test.ts` failed twice in full runs while other lanes held transactions (section 3).

## 6. Requests to other lanes, through root

None.

## 7. Dependencies added

None.

## 8. For later lanes

- Any page that quotes a post title or comment text can reuse `describeTargets`' pattern: `postViews(rows, viewer)` decides deleted, removed, closed and the age gate; then `shows(nsfw, view.community.id)` for flagged views (`view.sensitive` and `view.nsfl` already include the community flags).
- `pnpm e2e --project serial` runs the serial specs alone (no `--no-deps` needed any more). A spec that saves a site setting other pages read belongs in `*.serial.spec.ts`.
- The media proxy's `gatedFetch` (`web/routes/media/proxy/-handler.ts`) is the place to add any further per-hop checks.

## 9. Left open and risks

- Timing budgets (comments render, reports queue, moderators cache) fail under this machine's load; each passed alone.
- A lane database used for many e2e runs passes 200 local communities and the composer specs fail (section 3); not a product problem for the beta, but a long-lived lane database needs recreating now and then.
- A4 has no lab or e2e proof against a real redirecting peer; the unit test drives the handler with a stub client.
