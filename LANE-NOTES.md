# Lane FX-REPORTS notes (wave 3 review fixes: reports)

Branch `mvp-w3-fx-reports` from `w3-review` (96d94dd), worktree `/Users/admin/Projects/feddit-mvp-w3-fx-reports`, `lane.sh` name `rep`, port 18319. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`.

## 1. What landed

| Finding              | Commit  | Proving test                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 (report creation) | 5da4161 | `c/reports/reports.test.ts` "a person site-banned after the form was authorised cannot file the report" (grant issued, then the ban, then the mutation: `auth.site_banned`, no row)                                                                                                                                                                                                   |
| A2                   | d7cf723 | `c/reports/reports.test.ts` "authority is current when the queue acts": a stale moderator cache refuses resolve and route (`mod.moderator_required`); and, for resolve and for route, two connections: a removal holds the community row FOR NO KEY UPDATE and deletes the moderator row, the action waits on the lock (`pg_stat_activity`), then is refused once the removal commits |
| A7                   | d742094 | `c/reports/read.test.ts` "a former moderator no longer reads the groups they escalated, open or closed" (Escalated and Dismissed tabs empty after removal; admins still see them)                                                                                                                                                                                                     |
| D9                   | 5adc9ed | `c/reports/read.test.ts` "a group resolved between the two reads is left out, not a crash": the read handle is wrapped so the resolution runs after the group list returns and before the reports read. Before the fix: `TypeError: Cannot read properties of undefined (reading 'createdAt')`                                                                                        |
| D8                   | 593a87f | `c/reports/read.test.ts` "a group shows its total and only its newest reports" (25 reports: count 25, oldest and newest from all, categories from all, the 20 newest listed). The budget test still passes                                                                                                                                                                            |
| S10                  | 1cd3bf5 | `c/reports/form.test.ts` "a post and a comment in an NSFW community, for an undeclared and a declared viewer"; `c/reports/read.test.ts` "the quote is plain, short and withheld ..." (a community's NSFW flag, a comment under a removed post)                                                                                                                                        |
| F4                   | ac1fbc2 | `c/reports/form.test.ts` "a forwarded report names every host it goes to" (community and author hosts, author only, community only, none; the receipt's `forwardedTo` for a forwarded and a kept report)                                                                                                                                                                              |
| W4                   | bca0c45 | `w/routes/report/-back.test.ts` (the review's `%2F%09%2Fevil.example`, tab, line break, `//`, backslash, absolute URL: all `/`; a path on this site is kept)                                                                                                                                                                                                                          |

How each one works:

- A1: `createReport` sets `recheck: true`. The recheck runs the principal refresh, which reaches `auth.site_banned`, and reruns the policy with locks, so content removed in between is refused too. Inbound Flags go through the same recheck (the remote reporter's site ban counts).
- A2: `resolveReports` and `routeReports` set `recheck: true`. The policy then reads the community row FOR NO KEY UPDATE and the moderator row FOR SHARE (`communityState`, `communityRole` with `lock`), never the moderator cache. `authz/**` is unchanged.
- A7: `visibleRows` (`c/reports/scope.ts`): a moderator's `escalatedBy` branches (Escalated, Resolved, Dismissed tabs) also need the row's community among those the viewer moderates now.
- D9 and D8: `readQueue` reads each group's count, oldest and newest time, categories, escalator and closure (from the lowest-numbered report, as before) in the group query. A second query loads at most `groupReportLimit` (20) reports per group, the newest, with `row_number()`. A group that has no reports left by the second read is dropped, and no lookup uses `!`.
- S10: the form quotes a post or comment only when `readPost(postId, viewer, q, nsfw)` gives `gate: 'none'` and the post is neither deleted nor removed. That covers the post and community NSFW and NSFL flags, the age declaration and Hide NSFW, all for the viewer. The web loader passes `requestNsfw()` from `w/routes/c/-gate.ts`, unchanged. The queue now withholds the quote ('sensitive') for the community's flags too, and ('removed' or 'deleted') for a comment under a removed or deleted post and for a deleted or removed community.
- F4: `ReportForm.host` became `hosts: string[]` (`forwardHosts` in `c/reports/form.ts`), addressed as `federation.reports` does: the remote community's host, then the remote author's when it is another. The checkbox reads "Also send to the moderators of {hosts}. They will see the report and your handle." `SentReport` gained `forwardedTo`. The receipt keeps "will not learn who you are" only when it is empty; otherwise it says "The moderators of {hosts} can also see the report, including your handle." Both are in en and de; the list is joined with `Intl.ListFormat`.
- W4: `back` is normalised by `reportBack` (`safeRedirect`) in the server functions behind both pages and in the POST handler. The pages' own client-side regex checks are gone.

## 2. Commits

| Commit  | Change                                           |
| ------- | ------------------------------------------------ |
| 5da4161 | A1: recheck report creation                      |
| d7cf723 | A2: recheck resolve and route                    |
| d742094 | A7: current moderation for escalations           |
| 5adc9ed | D9: drop vanished groups                         |
| 593a87f | D8: bounded queue page                           |
| 1cd3bf5 | S10: form and queue gates                        |
| ac1fbc2 | F4: name every host, scope the anonymity promise |
| bca0c45 | W4: safe back links                              |
| (last)  | This file                                        |

## 3. Verification

- `pnpm check` before each commit. Green runs: 2,509 (A1), 2,513 (A7), 2,514 (D9), 2,515 (D8), 2,516 (S10) and 2,517 (F4) passed, 7 skipped, nothing failed. Before the A2 and W4 commits the only failure was `c/authz/moderators-cache.test.ts` "a mod.role event drops the pair it names, through the registered consumer". It polls `processBatch`, which reads below the cluster's oldest open transaction (other lanes share this Postgres; load average about 13). It passed 3 of 3 alone each time, the reports tests do not touch it, and the next full run after A2 was green. Last full run: 2,523 passed, 1 failed (that test), 7 skipped.
- Every finding's test was run against the code before its fix (stash) and failed, then passed after. The exception is W4: its test targets the new helper. The old inline check (`/^\/(?!\/)/` and no backslash) accepts the review's decoded `/\t/evil.example`; I confirmed that with a one-off check.
- `pnpm build && pnpm e2e` on 18319: the first run had 327 passed, 1 failed, 1 skipped and 25 did not run. The failure was the 200 ms timing budget in `e2e/comments/comments.spec.ts:320`, under load, and the serial project then did not run (W9). That spec alone passed, the serial project alone passed 15 of 15, and a second full run was green: 353 passed, 1 skipped.
- Schema: none. Nothing under `packages/core/drizzle/` changed and no scratch migration was needed.

## 4. Decisions and deviations

1. D8 shows the 20 newest reports of a group in number order (oldest of those first, as before). Categories are distinct, now in database order rather than order of first appearance. The closure and the escalator still come from the lowest-numbered report that has them.
2. D9: dropping vanished groups, not a snapshot transaction. `readQueue` takes any `Queryable`, and a nested repeatable-read transaction on a caller's handle is not possible. A group whose rows changed but did not vanish can show a count from the first read and reports from the second; the count is the total either way.
3. S10: the form keeps the "about" line (handles), as the post page keeps author and community under its gate. Only the quote is withheld, so a reporter can still report gated content. The queue does not ask who is looking: it withholds the quote for any flagged content (staff open it with Show or Open), which is stricter than a viewer gate.
4. F4: a host is the actor's inbox host (shared inbox first), falling back to its id's host when no inbox is stored. That matches the consumer's addressing and still names a host for actors the policy counts as remote recipients.
5. F4: the routing lines (`route.moderators`, `route.admins`) are unchanged. They describe the local audience, and the checkbox line now carries the disclosure for the remote one.
6. W4: `loadReportForm` and `loadSentReport` take an optional `back` and return it normalised. The dialog ignores it.

## 5. Requests to root

1. `c/authz/actions/reports.ts` header comment (not my write set) still says "the mutations carry no recheck". It should read: "Nothing revokes a report itself. createReport, resolveReports and routeReports set recheck: true, so the policies here run again with lock inside the transaction: the community row FOR NO KEY UPDATE, the moderator row FOR SHARE (no cache), and the principal refresh for site bans." Comment only.
2. If the README's write and locking rules list the rechecking mutations, add `report.create`, `report.resolve` and `report.route`.
3. e2e coverage I could not add (outside the write set): a forwarded-report receipt, and `back=%2F%09%2Fevil.example` on `/report` and `/report/sent` (expect `href="/"`). The core and web unit tests above cover the logic.

## 6. Requests to other lanes, through root

- FED: `forwardHosts` (`c/reports/form.ts`) mirrors `recipients()` in `f/delivery/reports/consumer.ts`. If FX-FED changes who an outbound Flag goes to (D3 gates peer blocks at send time, which skips a host but does not add one), keep the two in step.

## 7. Dependencies added

None.

## 8. For later lanes

- `groupReportLimit` (20) is how many reports a queue group shows; `group.count` is the total.
- `readReportForm(principal, target, q, nsfw)` takes the browser's Hide NSFW choice; pass `requestNsfw()` from a server function.
- `reportBack(back, origin)` (`w/routes/report/-back.ts`) is server only, since it imports `server/auth.ts`.

## 9. Left open and risks

- The `moderators-cache.test.ts` and e2e timing failures above are load and cross-lane effects, not changes here; they recur while other lanes hold long transactions.
- A2 and A1 add row locks to report creation (community and post FOR NO KEY UPDATE) and to resolve and route (community row). Reports are rare writes, so I expect no contention, but a burst of inbound Flags on one community serialises on its row.
