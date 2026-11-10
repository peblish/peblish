# FR4-AUTH lane notes (review 2 AN1 to AN3)

Branch `mvp-w4-fr-auth` from tag `w4-fixes` (0f091d7), `lane.sh` name `e1`, port 18315.

| Item       | Commit  | Proving test                                                                                                                                                                                                                                                                              | Schema change |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| AN1 (P2)   | 4b4a931 | `e2e/auth/enrolment.spec.ts` "only the session that started a TOTP setup can confirm it, and confirming signs the other out"; `identity/session.test.ts` "another session cannot confirm the setup through any verifier; the owner confirming through any of them ends it (review 2 AN1)" | none          |
| AN2 (P2)   | 839d827 | `identity/session.test.ts` "a restart by another session never shows the earlier owner its new key, even before the new owner is recorded (review 2 AN2)"                                                                                                                                 | none          |
| AN3 (root) | 60a8608 | `web/routes/admin/settings/-access.test.ts` "an admin whose session skipped two-factor is told to sign in again with a code, not to turn it on (review 2 AN3)"                                                                                                                            | none          |

## 1. What landed

- AN2: `identity/totp-setup.ts` (new). A setup's owner record is a better-auth verification row whose identifier is `peblish-totp-setup:<userId>:<fingerprint>`, the fingerprint being an HMAC-SHA-256, under the auth secret, of the base32 key that the starting session's own `enableTwoFactor` call returned. `ownedSetup` decrypts the row's current secret, fingerprints it and looks up that exact record, so a session sees or confirms a setup only while the current secret is the one it started. A restart by another session commits a new secret that no earlier owner holds, so the window the review found shows nothing. `startTotpSetup`, `pendingTotp` and `confirmTotpSetup` (`two-factor.ts`) use it. Proof: the AN2 test holds the phone's owner record `FOR UPDATE` on a second connection, so the laptop's restart stops after its new secret is committed and before its owner is recorded (detected through `pg_stat_activity`, not timing); in that window the phone's `pendingTotp` is null and its confirm is refused.
- AN1: `totpSetupGuard` in `identity/totp-setup.ts`, registered in `auth.ts` before the replay guard. Before every `verify-totp`, `verify-backup-code` and `verify-otp` call that carries a session, it refuses (`FORBIDDEN`, code `TOTP_SETUP_NOT_THIS_SESSION`) unless the call is `verify-totp` for a setup that session owns within its hour. Calls without a session (the sign-in challenge) go on as before. After a `verify-totp` that turned two-factor on (a request session and a new session, no error), it ends every other session of the account, forgets the setup's owners and records the one-time recovery-code reveal for the session handed out. So `/auth/two-factor`, the security page and any later caller get the same ownership, expiry, sign-out and reveal. `confirmTotpSetup` keeps only its own ownership check (to answer null without spending a code) and lets the guard do the rest. Proof: the core test calls `api.verifyTOTP` and `api.verifyBackupCode` directly with the second session (refused), checks expiry (owner record past its hour: the owner is refused too), then confirms with the owner through `api.verifyTOTP` itself and sees the other session gone, the replacement marked and the codes revealed once. The e2e spec does it through the real pages: two password sign-ins, the laptop starts, the phone sees no key and posts the laptop's current code to `/settings/security` (no change) and to `/auth/two-factor` (refused, `two_factor.invalid_code`), then the laptop confirms with the same code and the phone lands on sign-in.
- AN3: `web/routes/admin/settings/-access.ts` returns `needs-two-factor-sign-in` for an admin account with two-factor on whose session did not pass it; `AccessNotice` (`-ui.tsx`) shows `access.signInWithTwoFactor` ("Sign in again with a two-factor code to use this page." / "Melde dich erneut mit einem Zwei-Faktor-Code an, um diese Seite zu nutzen."). This covers Settings and Pages, the two areas that use `accessOf`.

## 2. Commits

839d827 AN2, 4b4a931 AN1, 60a8608 AN3, then this file.

## 3. Verification

- `pnpm check` before each commit, no `PEBLISH_MIGRATIONS_DIR` needed (no schema change; migrations stop at `0012` in the tree).
  - AN2 (839d827): green, 239 files passed (5 skipped), 2,672 tests passed, 9 skipped.
  - AN1 (4b4a931): the full run had 7 failures in 6 files outside identity under a load average of 30 to 36 (the run took 21 minutes): `db/migrate.test.ts` (hook and test timeouts, then a duplicate `pg_database` name from the timed-out hook), `comments/mutations.test.ts` (5 s timeout), `authz/moderators-cache.test.ts` (the load-sensitive consumer test the FX4-AUTH notes name), and federation `inbound/pipeline.test.ts`, `inbound/receive.test.ts`, `nodeinfo/client.test.ts` (timeouts). `pg_stat_activity` showed no connections left on the lane databases; those 6 files rerun alone passed (84 of 84). The AN1 commit rests on that rerun.
  - AN3 (60a8608): green, 240 files passed (5 skipped), 2,674 tests passed, 9 skipped.
- Each test fails without its fix: AN2 with `two-factor.ts` reverted and `totp-setup.ts` removed (the phone's `pendingTotp` returns the laptop's new key); AN1 core test on the AN2 commit (the phone's `verifyTOTP` resolves instead of rejecting); AN1 e2e spec on a build of the AN2 commit (the phone's post to `/auth/two-factor` answered 200 with `redirect: '/'`, that is, it confirmed); AN3 with its three source files stashed (`needs-two-factor`).
- `pnpm db:migrate && pnpm build && pnpm e2e` on 60a8608: serial set 33 passed. Parallel set 314 passed, 1 skipped, 1 failed and 10 did not run: `comments/comments.spec.ts` "a 500-comment thread that reaches level 50 ... rendered in under 200 ms" measured 220 ms at a load average of 35, and the 10 that did not run are the rest of that spec's serial block. `comments/comments.spec.ts` rerun alone: 25 of 25 passed. That makes 325 passed and 1 skipped in the parallel set, the FX4-AUTH count (324) plus the new enrolment spec.
- `git status` shows nothing under `packages/core/drizzle/`.

## 4. Decisions and deviations

1. AN1 takes the reviewer's second option (shared hooks for every call) rather than only refusing signed-in requests at `/auth/two-factor`: the hook covers that route, the security page and any future caller of better-auth's verifiers, and keeps the effects in one place. `/auth/two-factor` itself is unchanged; a refused call there reads as `two_factor.invalid_code`, so no new copy.
2. AN1: with a session, `verify-backup-code` and `verify-otp` are refused outright. The app never calls them with a session; better-auth would otherwise let any session of the account spend a recovery code. A signed-in owner posting its own setup code to `/auth/two-factor` confirms it with the same effects as the security page.
3. AN1: the guard runs before the replay guard, so a refused code does not claim its 30-second step (the e2e spec relies on it: the laptop confirms with the code the phone was refused with).
4. AN1: the after hook tells a confirmation from a sign-in by `ctx.context.session` (the request's session, which better-auth re-reads and leaves in place) next to `ctx.context.newSession`. If a better-auth upgrade changed that, the core AN1 test fails (no sign-out, no reveal).
5. AN2: ownership is keyed by the secret's fingerprint rather than written in the same statement as the secret, because better-auth writes the secret. Every start first deletes the account's earlier owner records, then inserts its own. Two concurrent starts can leave the current secret with no owner; that fails closed (nobody sees the key; starting again fixes it).
6. AN2: owner records written before this change (`peblish-totp-setup:<userId>`, no fingerprint) match nothing; a setup in progress at deploy has to be started again, and better-auth removes those rows once expired (within an hour).
7. AN2: owner rows and the reveal are written with Drizzle into `auth_verification` (root's table, used as is, no schema change) instead of better-auth's internal adapter, so the hook needs nothing from `auth.ts` and there is no import cycle.
8. Deviation (outside the listed write set): `packages/core/src/testing/seed-a.ts` gains an `e2e-person <name>` command (a fresh password-only account) for the AN1 e2e spec, and the spec is a new file `e2e/auth/enrolment.spec.ts`. Both are tests of the auth routes. The spec posts with `fetch` from inside the page because the lane origin is https, so the session cookie is `__Secure-` and Playwright's request context does not send it over the e2e server's plain http; the browser does.
9. Deviation (outside the listed write set): AN3 also edits `AccessNotice` in `web/routes/admin/settings/-ui.tsx` (one branch and its doc comment), which renders the denial; `-access.ts` alone cannot change the message. No other lane writes that file.
10. AN3: the new state is "role admin, two-factor on, session not marked". A site-banned admin with two-factor on (B07 A3) also lands there and is told to sign in again. The product cannot ban an admin (`target.protected`), so I left it.

## 5. Requests to root

1. AN3 for the other admin denials, which build their access themselves and have their own copy outside this lane: `admin/registration/index.tsx` (`invites.json` `admin.needsTwoFactor`), `admin/bans/-load.ts` and `index.tsx` (`bans.json` `needsTwoFactor`), `admin/peers/-load.ts` and `index.tsx` (`peers.json` `needsTwoFactor`), and Media (`mediascan.json` `media.needsTwoFactor`). Each could use `accessOf` and `AccessNotice` (or its own `needs-two-factor-sign-in` branch) with the same sentence in its area's catalogue.
2. Cutover runbook (as FX4-AUTH asked): sessions from before the two-factor marks have none, so Andrew signs in again with password and code; the admin pages now say exactly that.

## 6. Requests to other lanes

None.

## 7. Dependencies added

None. `@better-auth/utils/base32` comes from the existing `@better-auth/utils` dependency.

## 8. For later lanes

- The enrolment rules live in `totpSetupGuard` (`identity/totp-setup.ts`). Any code that calls better-auth's verifiers with a session gets them: only `verify-totp`, only the session's own setup, and the sign-out, owner clean-up and reveal afterwards. Do not reimplement them around a call.
- `ownedSetup(keys, userId, sessionId)` answers whether a session owns the account's current setup (pass `(await auth()).$context` or a hook's `ctx.context`).
- `accessOf` now has four answers; `AccessNotice` handles them all.

## 9. Left open and risks

- Decision 4 depends on better-auth keeping the request session in `ctx.context.session` through `verify-totp`; the AN1 core test is the tripwire.
- The other admin areas still say "Turn on two-factor" in the AN3 state (request 1).
- Load-sensitive tests under this machine's load (section 3).
