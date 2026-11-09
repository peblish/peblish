# Lane ADM notes (wave 3): admin Settings and Pages, kill switches, legal pages

Worktree `/Users/admin/Projects/feddit-mvp-w3-adm`, branch `mvp-w3-adm` from tag `w3-groundwork` (35fbc62), `lane.sh` name `adm`, port 18321. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`, `s/` `packages/schema/src`.

## 1. What landed

| Deliverable                                                                                                                                                                                                                           | Where                                                                                                       | Proof                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Settings service: the only writer of `site_settings`; typed patch, contract validation, sorted keys, default row first, locked update, one non-public modlog row with before and after, `settings.updated`, one transaction           | `c/settings/write.ts`, `c/authz/actions/settings.ts` (`settings.update`), `s/{refusals,events}/settings.ts` | `c/settings/write.test.ts` (policy table, recheck, invalid, no-op, change with xid checks) |
| Kill switches tested through the real mutation and reader: registration, uploads, remote media, posting (locals only), inbox and delivery (reader level), plus the flip that waits for a rechecked `account.register` holding the row | `c/settings/kill-switches.test.ts`                                                                          | the file; `w/routes/admin/settings/-copy.test.ts` (copy for every key in en and de)        |
| `/admin/settings`: identity, operator, cap with "N of cap used", one POST per kill switch, federation (NSFW, trusted domains), saved and field-error states, paused switch `role="status"`                                            | `w/routes/admin/settings/**`, `w/i18n/admin.json`                                                           | `e2e/admin/settings.spec.ts`; `-form.test.ts`                                              |
| Pages core: `pages` and `page_revisions`, `savePage`, `publishPage`, `unpublishPage`, `seedShippedPages`, token filling, reads                                                                                                        | `c/pages/**`, policies `page.save`, `page.publish`, `page.unpublish`                                        | `c/pages/pages.test.ts`, `c/pages/shipped.test.ts`                                         |
| The nine legal texts as seed drafts                                                                                                                                                                                                   | `content/legal/<slug>.en.md`, `w/routes/admin/pages/-bundled.ts`                                            | `c/pages/shipped.test.ts` (README step 3 checked per file)                                 |
| `/admin/pages` and `/admin/pages/$slug/$language`: list with status, Add the shipped drafts, editor with Save draft, Publish, Unpublish, tokens listed on refusal, saved draft rendered below                                         | `w/routes/admin/pages/**`                                                                                   | `e2e/admin/pages.spec.ts`                                                                  |
| `/$slug` for the ten slugs, `/about` fallback, "Legal and safety" list, reader's language else English with `lang`                                                                                                                    | `w/routes/$slug.tsx`, `w/routes/-legal/**`                                                                  | `e2e/admin/pages.spec.ts`                                                                  |
| Test seed and CLI                                                                                                                                                                                                                     | `c/testing/seed-adm.ts` (`e2e`, `e2e-pages`, `settings-log`)                                                | the e2e specs                                                                              |

## 2. Commits

| Commit        | Change                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| b238e54       | Settings service, policy and kill-switch tests                         |
| b5c55eb       | Admin Settings tab                                                     |
| a240f17       | CMS pages core                                                         |
| 212a439       | The nine shipped legal texts                                           |
| effbfde       | Admin Pages tab, editor and public pages                               |
| dd1b895       | Unchanged settings stay unlocked; e2e specs keep to their own log rows |
| (this commit) | Switch specs that stop other specs run only alone; this file           |

## 3. Verification

- `pnpm check`: build, typecheck and lint pass. Tests: baseline at the tag 2,102 passed, 3 skipped; final 2,141 passed, 3 skipped, 9 failed (166 files, run with `--testTimeout=60000`). None of the 9 touch this lane; each file is outside my write set and unchanged:
  - Seven are the backfill tests (`c/remote/backfill.test.ts` 5, `f/backfill/backfill.test.ts` 2). They fix their clock at `2026-11-09T12:00:00Z` while the database stamps rows with the real time, so they started failing when the real clock passed 12:00 UTC (the failing runs were at 12:0x UTC; the same files passed at 11:4x). Root should make those tests independent of the date.
  - Two are `c/outbox/worker.test.ts` cases that depend on the cluster's oldest open transaction. The shared Postgres and the CPU were heavily loaded by the other lanes (load average 30 to 60), and which of the worker, migrate, receive and moderators-cache timing tests flaked changed from run to run; each passes alone or with a longer limit.
- `pnpm build && pnpm e2e --workers=3` on port 18321: 242 passed, 4 skipped (baseline 218 passed, 1 skipped; this lane adds 24 specs and 3 skipped flips, see decision 15). With the default worker count the "500-comment thread renders in under 200 ms" case in `e2e/comments` failed under that load (best of 5 at 415 ms) and passes alone (`pnpm e2e e2e/comments`: 25 passed).
- Tests and e2e ran on a scratch migration holding `pages` and `page_revisions` (`PEBLISH_MIGRATIONS_DIR`). Nothing under `packages/core/drizzle/` changed.
- `PEBLISH_E2E_FLIP_ALL=1 pnpm e2e e2e/admin --workers=1`: 23 passed, 0 skipped (the switch flips that stop other specs).
- Core tests of this lane: `c/settings` (write, read, kill-switches) and `c/pages` (pages, shipped) 46 tests; web `-form`, `-copy` 4.

## 4. Decisions and deviations

1. The Settings save form and the kill switches are separate forms (a switch is its own POST, and forms cannot nest). To keep the mock's order (cap, switches, federation), the federation fields and the Save button sit after the switches and belong to the save form through the `form="settings-save"` attribute; it works without JavaScript.
2. Plain `<input>` and `<textarea>` in `.fld` (lane A's pattern) on Settings; the facade `TextField` and `TextAreaField` in the page editor. Both are inside the payload budget (editor 128.2 kB of 170).
3. The save form has `noValidate`: the browser's own email check would stop a bad contact email before the server could mark the field. A refused save redirects to `?error=settings.invalid&field=<key>` and shows the stored values again; what was typed is not kept (the fields have `maxLength`, so only a bypass reaches it).
4. A kill switch button posts the state it wants (`state=on|off`), not a toggle, so a second click does nothing.
5. `updateSettings` reads a key without a lock first and takes `FOR NO KEY UPDATE` only when the value changes, so saving the other fields does not wait on a registration in flight. `updateSettingsAs` authorizes first and then validates (`settings.invalid`), so only an admin learns what is acceptable. Trusted domains are trimmed, lowercased, de-duplicated and checked against a host pattern (`settings.invalid` otherwise).
6. `invalidSetting(patch)` (core) names the first bad key so the form can mark its field.
7. The pointer lives on `pages.published_revision` with a foreign key to `page_revisions`; `page_revisions` has no foreign key back (history outlives a draft). Status "Unpublished changes" is `pages.updated_at` later than the live revision's `created_at`; a save of identical text writes nothing, so it does not trigger it. `updated_at` is written with `clock_timestamp()` for that comparison.
8. Deviation, an addition: `unpublishPage` writes a non-public modlog row (`page.unpublish`, `details.page` with the withdrawn revision), as publish does. The brief only said it clears the pointer; a page leaving the site is an admin action worth the same trail. `savePage` writes no modlog row, as briefed.
9. `seedShippedPages(principal, shipped)` takes the pages from its caller (the web bundle), because core cannot glob files; each page is its own authorize and write, never overwrites, and uses `insert ... on conflict do nothing`. The first `# ` heading of a shipped file is the page title and is removed from the body (the page route prints the title as the H1).
10. Publishing from the editor saves the form first and then publishes, so what is on screen is what goes live. A token value that itself looks like `{{TOKEN}}` is written as text, never filled again. The postal address goes into running text on one line, its lines joined with commas.
11. Shipped texts, beyond README step 3 (drop the first line and `Status:`, keep `Effective date: {{EFFECTIVE_DATE}}.`, sibling links to `/<slug>`, drop baseline citations, form tokens become the Report action plus `{{CONTACT_EMAIL}}`): the sentences that carried a baseline citation lose only the citation (and its `[I]` label), except two claims that rested on the baseline alone: privacy "the baseline reports a two-year Australian Code compliance-record measure" and under-16 "COPPA scope ... remain unverified in the baseline" (the second keeps the claim without the source). Operator-only notes are gone: the terms' "Operator must confirm ...", privacy's "must be adopted ... before this page is published", "Proposed project choice for the operator to confirm" and "Operator choice confirmed 2026-11-09", and the Easypanel "must be recorded before activation". The evidence labels `[L]`, `[I]`, `[R]`, `[S]` that cite public sources stay: they are part of the drafts and Andrew can edit them in the Pages editor. `take-it-down` says "Report action on the post, or email" in place of the intimate-image form.
12. Which pages can publish after the operator settings alone: `rules`, `moderation-policy`, `federation-policy`, `take-it-down`, `under-16` (tested). `dmca`, `illegal-content`, `terms` and `privacy` keep tokens only the operator can fill (DMCA agent, DSA and TCO representatives, processors, retention figures) and stay unpublishable until Andrew writes them into the draft.
13. `/$slug` only looks anything up for the ten slugs; any other single segment is the ordinary 404. The reader's language comes from Accept-Language in the server function (`Vary: Accept-Language`), the same negotiation as the shell: their language if a revision is live, else English, else 404 (a page live only in German is a 404 for an English reader, as briefed).
14. The admin routes set their own `<title>` ("Settings · <site>") through `adminHead`, since the shell's title table (root-owned) has no entry for them. TanStack Router rewrites `?saved=1` to `?saved="1"` after hydration (a numeric-looking string); harmless, and the specs match `saved=`.
15. e2e: every spec file runs side by side on one database, and my switch specs pause global switches (sign-up, posting, remote images) that other specs use; in the first full run a composer spec lost a post to my posting pause. So registration, posting and remote media flip only with `PEBLISH_E2E_FLIP_ALL=1` and one worker; outgoing delivery and the inbox (its own 401, 503 with `Retry-After`, 401 test, a few hundred ms) flip in every run; uploads is covered by the render check because the composer spec flips it. `kill-switches.test.ts` flips all six through the real mutation. The two spec files use their own admins (`adm_admin`, `adm_pages_admin`) and reset only their own settings, because the server takes a TOTP code once per 30 s step.

## 5. Requests to root

- Migration `0008`: tables `pages` and `page_revisions` in `c/pages/tables.ts` (indexes: primary key `(slug, language)`, `page_revisions_page`). Generated as the scratch migration `0008_adm_scratch.sql`.
- `page_revisions` is append-only in code (nothing updates or deletes a row). If you add a refuse-update-and-delete trigger as for `modlog`, add the table to `truncateGuards` in `c/testing/db.ts`; `seed-adm.ts` (`e2e-pages`) clears the table on the lane database and would then need the trigger disabled the same way.
- `e2e/payload/routes.ts`: three entries added (exception in decisions): `/admin/settings/`, `/admin/pages/`, `/admin/pages/$slug/$language` (target `/admin/pages/rules/en`), and `/$slug` (target `/about`).
- A serial e2e project (or `workers: 1` for `e2e/admin`) would let the switch flips of decision 15 run on every CI run; today `PEBLISH_E2E_FLIP_ALL=1` runs them by hand.
- The image build copies the repository (`COPY . .`, no `.dockerignore` entry for `content/`), and the legal texts are inlined into the server bundle at build time (checked: they are in `.output/server/_ssr/-bundled-*.mjs` and not in `.output/public`). Please keep `content/` out of `.dockerignore`.
- `registration/settings.ts` (lane A's) reads the two registration keys in one statement with no order. A single patch that changes both `registration.cap` and `registration.enabled` while a registration is in flight could deadlock (40P01) because my write locks them in key order; no form of mine sends both, so it is theoretical. An `order by key` in that reader would remove it.

## 6. Requests to other lanes, through root

- MODF: the modlog feed should label `settings.update`, `page.publish` and `page.unpublish` rows generically (they are `public: false`, `details.changes` or `details.page`) and show non-public rows to admins only; Peers leaves out the trusted-for-modlog list (it lives in Settings).
- FED-C: `deliverDue` claims nothing while `delivery.enabled` is false, with a test (the Settings row and `readSetting('delivery.enabled')` are in place).
- B06 and the cutover runbook: set `site.name` to "Feddit" in Settings; fill the operator name, contact email, postal address and jurisdiction; add the shipped drafts; edit the four texts that keep tokens; publish.

## 7. Dependencies added

None.

## 8. For later lanes

- Write settings only with `updateSettingsAs(principal, patch)` (`c/settings/write.ts`); read with `readSetting(key)` or `readSettings()` (`c/settings/read.ts`). A new key goes in `s/site-settings.ts` (root) and, if it is a switch, in `killSwitches` plus its six `settings.switch.<key>.*` strings in `admin.json`.
- A new page slug: add it to `pageSlugs` (`c/pages/slugs.ts`) and a `pages.slug.<slug>` string in en and de; the list, editor and `/<slug>` follow. A shipped text is `content/legal/<slug>.en.md` starting with a `# Title` line.
- `publishedPages(language)` and `readPublishedPage(slug, language)` (`c/pages/read.ts`) are what a footer or a sitemap should read.
- The admin Settings and Pages routes share `w/routes/admin/settings/{-access.ts,-ui.tsx}`: `accessOf`, `AccessNotice`, `AreaField`, `adminHead(titleKey)`.

## 9. Left open and risks

- The four texts with tokens need Andrew's input before they can publish; the evidence labels (`[L]`, `[I]`, `[R]`, `[S]`) are still in the shipped texts. German legal texts are out of scope: a German reader gets the English text with `lang="en"` until a German version is published.
- The sidebar footer links to `/rules /terms /privacy /about` answer 404 until those pages are published (`/about` answers with the name and description).
- A failed save returns to the stored values; a very long edit that fails would be lost (browser limits stop the usual cases).
- The full `pnpm check` and e2e ran on a machine at load average 30 to 60; section 3 says what failed and why. The 9 failing tests (backfill clock, worker horizon) are root's to fix before the wave 3 PR.
