# FX4-AUTH lane notes (B07 A1 to A5)

Branch `mvp-w4-fx-auth` from `w4-base` (a606db2), `lane.sh` name `e1`, port 18315.

| Finding | Commit  | Proving test                                                                                                                                                                         | Schema change                                         |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| A1 (P1) | f81e756 | `identity/session.test.ts`: "an admin counts as one only with two-factor on, in a session that passed it (B07 A1)", "confirming a TOTP setup signs every other session out (B07 A1)" | New table `session_two_factor` (`identity/tables.ts`) |
| A2      | 1963857 | `identity/session.test.ts`: "another session of the account sees neither the setup key nor the recovery codes, and cannot confirm (B07 A2)"                                          | none                                                  |
| A3      | 1aa4387 | `authz/staff-bans.test.ts`; `identity/session.test.ts`: "a site-banned admin account has no admin authority (B07 A3)"                                                                | none                                                  |
| A4      | 98c6f66 | `identity/delete.test.ts`: "a site-banned person may delete their own account, and only their own (B07 A4)"                                                                          | none                                                  |
| A5      | 3f32b30 | `identity/sessions/sweep.test.ts`                                                                                                                                                    | none                                                  |

## 1. What landed

- A1: `identity/session-two-factor.ts`. A better-auth plugin (`sessionTwoFactorMarker`, registered in `auth.ts`) records a `session_two_factor` row for the session that `/two-factor/verify-totp` or `/two-factor/verify-backup-code` creates. That covers the sign-in challenge and the TOTP setup confirmation. `currentSession` gives `siteRole: 'admin'` only with role admin, two-factor on and that row. `confirmTotpSetup` signs every other session of the account out. `changePasswordAs` (`two-factor.ts`, used by the security page) carries the mark to the replacement session. The principal recheck (`authz/principal.ts`) can now only take admin away: a `'user'` principal for an admin account stays a user. Proof: the A1 tests above.
- A2: `two-factor.ts`. `startTotpSetup` (now used by the page's `totp-start`) records which session started the setup, as a better-auth verification value that lasts 1 hour. `pendingTotp` and `confirmTotpSetup` answer only that session. The recovery-code reveal is keyed by the session that confirmation hands out, and `takeRecoveryCodes(userId, sessionId)` consumes it only there.
- A3: `authz/roles.ts`. `freshModerator` (the one rule every moderator read and listing uses) excludes a moderator under a site ban in force. `moderationAuthority` refuses a site-banned principal with `auth.site_banned` when unlocked, so a cached role cannot grant. With a lock, the recheck already refuses. `currentSession` gives no admin role while a ban is in force. `reports/scope.ts` needed no change: it reads moderators through `freshModerator`.
- A4: `authz/authorize.ts` and `authz/principal.ts`. For `account.delete` where the subject is the principal's own actor, the recheck skips only the site-ban check (`siteBanExempt`). The actor, deletion and ownership rechecks still run, and web still checks the password.
- A5: `identity/sessions/sweep.ts` and `identity/sessions/job.ts` (job `identity.session_sweep`, every hour). It deletes expired sessions, 1,000 rows a statement and at most 25 statements a run, claimed FOR UPDATE SKIP LOCKED. Two-factor marks go with their sessions by cascade.

## 2. Commits

f81e756 A1, 1963857 A2, 1aa4387 A3, 98c6f66 A4, 3f32b30 A5, then this file.

## 3. Verification

- `pnpm check` green before every commit, all with `PEBLISH_MIGRATIONS_DIR` set to the scratch copy that has `0012`. After A5: 233 files passed (5 skipped), 2,632 tests passed, 9 skipped.
- On the A1 run, `authz/moderators-cache.test.ts` ("a mod.role event drops the pair it names, through the registered consumer") timed out once under load. It passed when rerun alone (4 of 4). The A1 commit rests on that rerun of that file alone.
- I checked that the A1, A3 and A4 tests fail without their fixes (code changes reverted by hand) and pass with them. The A2 test calls the new session-scoped signatures, so it cannot run against the old code. Under the old account-wide behaviour, the phone would have seen the key and the reveal.
- `pnpm db:migrate && pnpm build && pnpm e2e`: 324 passed and 1 skipped; serial set 33 passed.
- `git status` shows nothing under `packages/core/drizzle/`.

## 4. Decisions and deviations

1. A1 marks sessions in a new table rather than a column on `auth_session`, because `db/tables/auth.ts` is root's. The row cascades with its session. A verification value would have expired while the rolling 30-day session lived on.
2. A1: only sessions that better-auth's verify endpoints create get the mark. A code verified inside a session that already exists creates nothing, so it does not upgrade that session. No such step-up path is wired up today.
3. A1: a password change used to drop admin authority until the next sign-in, because better-auth replaces the session. `changePasswordAs` keeps the mark, which preserves today's behaviour for admins. Turning two-factor off makes a new, unmarked session, and admin needs two-factor on anyway.
4. A1: `verify-totp` answers with the replaced session's token. `confirmTotpSetup` therefore finds the new session from its Set-Cookie (`api.getSession`).
5. A2: a started setup is offered to its session for 1 hour. After that, nobody sees it, and starting again makes a new key (better-auth overwrites an unconfirmed secret).
6. A3, behaviour beyond reads (flagged for the follow-up review): because the rule is in `freshModerator`, a site-banned moderator also drops out of public moderator lists and badges (communities, profiles, comment author badges) and out of a local community's served moderators collection (`fed/actors/serve.ts`) while the ban is in force. They come back when it ends. I chose this so that one rule covers every staff read without editing other lanes' files. Peers mirroring our moderators collection will see the person removed and re-added. If root prefers public listings unchanged, the alternative is a separate `actingModerator` predicate, and every viewer-based moderator read (`posts/read.ts`, `comments/read.ts`, `communities/page.ts`, `feeds/read.ts`, `feeds/shell.ts`, `bans/read.ts`, `reports/read.ts`) would have to switch to it.
7. A3: `currentSession` also refuses admin to a banned admin account. The product cannot ban an admin (`target.protected`), but the command line could promote a banned person.
8. A4: a banned admin deleting someone else is still refused with `auth.site_banned`. The exception is your own account only.
9. A5: the brief names `tns/policies/privacy.md`, which is not in this repository. The retention row is in `content/legal/privacy.en.md` ("Sessions and reset/verification secrets ... purge residual records within 30 days"). The sweep covers sessions only, because better-auth already deletes expired verification values on every lookup (`internalAdapter.findVerificationValue`).

## 5. Requests to root

1. Generate the real `0012` from `identity/tables.ts`: table `session_two_factor` (`session_id uuid primary key references auth_session(id) on delete cascade`, `verified_at timestamptz not null default now()`). My scratch version is `0012_fx4_auth.sql` in the lane scratch folder.
2. Optional: an index on `auth_session (expires_at)` in `db/tables/auth.ts` (root's) would make the hourly sweep an index scan. Without it, the sweep scans the whole table, which is small at beta size.
3. At cutover, every session from before this change has no mark, so Andrew signs in again (password and TOTP) to get admin back. That is expected; say so in the runbook.

## 6. Requests to other lanes

None. Through root, FX4-FED should know that a site-banned local moderator now leaves the served moderators collection (decision 6).

## 7. Dependencies added

None.

## 8. For later lanes

- Admin means role admin, two-factor on, and a session in `session_two_factor`. Tests that need an admin web session must sign in through the challenge (`api.signInEmail`, then `api.verifyTOTP`). A password session plus `seedTwoFactor` is no longer an admin. Principals built by hand (`seedAdmin`, `admin()`) are unaffected.
- Call `startTotpSetup`, `pendingTotp(userId, sessionId, email)`, `confirmTotpSetup(userId, sessionId, headers, code)` and `takeRecoveryCodes(userId, sessionId)` with the session's id. Change passwords through `changePasswordAs`.
- `siteBanned(actorId)` (`authz/roles.ts`) is a SQL predicate for a site ban in force.

## 9. Left open and risks

- Decision 6 changes what appears in public listings and federation. It is the main item for the follow-up review.
- The moderator cache test is sensitive to load (one timeout, passed alone).
