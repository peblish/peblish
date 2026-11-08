# Lane A notes: identity, sessions, invites, the 16+ declaration, deletion

Branch `mvp-w1-a`, from `mvp-w1` at 790a03c. Plan rows A01, A03, A05 and M20.

## What landed

| Deliverable                                                                                                                                                                                                                               | Where                                                                                                   | State |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----- |
| better-auth on the 0001 auth tables: email and password (12 to 128 characters), verification links for 24 hours, password reset (1 hour, every session revoked), sessions in Postgres with user agent and IP, TOTP with 10 recovery codes | `packages/core/src/identity/auth.ts`, web glue in `packages/web/src/server/auth.ts`                     | done  |
| `account.register` for the system principal, plus the admin bootstrap                                                                                                                                                                     | `packages/core/src/registration/register.ts`, `packages/core/src/identity/bootstrap.ts`, `admin-cli.ts` | done  |
| `invite.create`, `invite.revoke` (site admin with two-factor on)                                                                                                                                                                          | `packages/core/src/registration/invites.ts`                                                             | done  |
| `account.delete` (owner, or a site admin for someone else)                                                                                                                                                                                | `packages/core/src/identity/delete.ts`                                                                  | done  |
| Policies for all five actions                                                                                                                                                                                                             | `packages/core/src/authz/actions/identity.ts`                                                           | done  |
| Session list and revoke, TOTP setup state, verify-link outcomes, handles                                                                                                                                                                  | `packages/core/src/identity/{session,two-factor,verify,handles}.ts`                                     | done  |
| Refusals, events, sign-up rules, views                                                                                                                                                                                                    | `packages/schema/src/{identity,session,invite}.ts`, `refusals/identity.ts`, `events/identity.ts`        | done  |
| Pages from `auth-pages.html` and `invites-table.html`                                                                                                                                                                                     | `packages/web/src/routes/{auth,invite,settings/account,settings/security,admin/registration}/`          | done  |
| Strings in en and de                                                                                                                                                                                                                      | `packages/web/src/i18n/{auth,settings,invites}.json`                                                    | done  |
| Seeds                                                                                                                                                                                                                                     | `packages/core/src/testing/seed-a.ts`                                                                   | done  |
| End to end                                                                                                                                                                                                                                | `e2e/auth/{flows,pages}.spec.ts`, `e2e/auth/support.ts`                                                 | done  |

Events: `account.registered` (with `actor.created`) at sign-up and bootstrap; `invite.created`, `invite.revoked`; `actor.deleted` at deletion.

## How it was verified

- `pnpm check`: green. 37 test files, 263 tests (G0 had 31 and 242), no boundary violations, Prettier clean.
- `pnpm e2e`: 30 of 30 on the build, on port 18302, after dropping `peblish_a` and recreating it with `scripts/lane.sh a` (fresh migrate, then the flows from an empty database).
- Core tests cover these guarantees: one-transaction sign-up (actor, RSA-2048 PKCS#8 and SPKI key, credential that better-auth's own sign-in accepts, invite use, declaration, events); every refusal reason, with nothing written; two sign-ups racing for the last invite use and for the last cap slot (one wins each time); invite admin needing two-factor; revoke; the used-by chain; deletion keeping the actor, its ap_id and key, scrubbing the profile, removing the login and sessions, with the ledger row and `actor.deleted` in the same transaction (checked by xid); admin deletion refusing another admin; session list and revoke by owner only; admin role only with two-factor; bootstrap once; TOTP setup key, then recovery codes shown once; mailed verify and reset links; better-auth's own sign-up off.
- e2e: the admin signs in with TOTP and creates an invite. A person opens `/invite/<code>`, signs up with a date of birth, verifies through the Mailpit link (then sees "already used"), turns on TOTP from the QR key, and signs in with a code and with a recovery code. They revoke one session, then all others; the other browser is signed out. They reset the password by mail, then delete the account, and the lane database shows the ledger row and the event. An under-16 date of birth shows the block page and sets an HttpOnly cookie for 24 hours, and the invite stays unused. Sign-in works without JavaScript. The signed-out pages hydrate without mismatch and pass axe in en-US and de-DE; the admin and security pages pass axe too.

## Decisions (deviations from the brief are marked)

1. **Deviation: better-auth lives in core, in `c/identity/auth.ts`, not in `w/server/auth.ts`.** Only core may hold the write pool (lint rule `core-writer-access` names `core/identity` for better-auth), and web may not import drizzle or `core/db`. `w/server/auth.ts` is the web glue: CSRF check, form reading, the 303 or JSON answer, cookies, the session for a request.
2. **No better-auth HTTP endpoint is mounted.** The form handlers call `auth.api` directly. better-auth's own sign-up is off (`disableSignUp`), so nothing can create an account past the invite gate. The verification and reset links point at our own pages (`/auth/verify?token=`, `/auth/reset?token=`).
3. **Sign-up is one mutation.** `account.register` writes the better-auth user and credential rows itself, in the exact shape better-auth's sign-up writes (provider `credential`, account id = user id, better-auth's scrypt hash). The same transaction writes the actor, key, declaration and invite use; a better-auth hook would have run in a second transaction. The test proves better-auth signs that user in. The password hash and the keypair are computed before the transaction opens.
4. Base URL, issuer and cookies follow the local instance's stored origin (migrate writes it). Cookies are `__Secure-peblish.*` under https; Chromium accepts them on http://127.0.0.1, so e2e needs no extra configuration. The secret comes from `BETTER_AUTH_SECRET` (32 characters or more). Without it, a fixed development secret is used only for localhost and `*.test` hosts; any other host refuses to start auth.
5. **Admin role convention:** `auth_user.role` is `'user'` or `'admin'` (better-auth's admin-plugin spelling; the plugin is not used). The first admin comes from `printf '%s' "$PASSWORD" | node packages/core/src/identity/admin-cli.ts <name> <email>`, which refuses once an admin exists (`admin.exists`). It records the 16+ declaration and a verified email. **TOTP is mandatory for admins (A03):** `SessionView.siteRole` is `'admin'` only when the role is admin and two-factor is on. The invite and admin-deletion policies re-check both and refuse with `admin.two_factor_required`. The admin page explains this and links to security settings.
6. **Deletion is immediate, with no grace period.** The actor row stays with its ap_id, endpoints, key and content. The display name, summary, icon and banner are scrubbed and `deleted_at` is set. The better-auth user is deleted, which cascades to its sessions, credential and two-factor and removes the email; `actors.user_id` becomes null. One `deletion_ledger` row (`subject_kind 'actor'`, details `{ userId, authority }`) and `actor.deleted` commit in the same transaction. Posts and comments stay, credited to the deleted actor. No data export exists before deletion. `account.delete` has no recheck, since nothing a moderator does revokes it; the body locks the actor row and re-checks it.
7. **Deviation: the referrer is `invites.created_by`, the parent in the invite chain.** No new column was added. The admin who made the invite is in `invite.created.adminId`. The label is `invites.note`. The chain is `invite_uses.actor_id` → `invite_uses.invite_id` → `invites.created_by`.
8. **Deviation: invite codes are shown once.** 0001 stores only their hash, so the admin table cannot show or copy a code after creation (the mock shows codes and Copy link in every row). The code is shown once, with the link and Copy, right after Create. Rows are named by label. If codes should stay visible, add a `code_hint` column (the last four characters, say).
9. **Deviation: expiry is 7, 30 or 90 days, or never.** The mock's "on a date" option was dropped.
10. The 16+ declaration is a new table, `age_declarations(actor_id, declared_at)`: the row is the fact, `declared_at` is when. The age is computed in UTC from the three form fields, and the date of birth is never stored or logged. The age check runs right after the kill switch, before the invite, so an under-16 answer blocks whatever invite was used. The block is the cookie `peblish.age_gate` (24 hours, HttpOnly, SameSite=Lax, Secure on https). Both the page and the POST check it. It is a reasonable step, not a control.
11. The cap counts local people with a login who are not deleted. The recheck takes an advisory transaction lock (`peblish.accounts`), so two sign-ups cannot share the last slot.
12. **Deviation: there is no breached-password check.** The only one on offer, haveibeenpwned, needs a network call. The minimum is 12 characters, with no composition rules.
13. **Deviation: there is no general rate limit.** better-auth's limiter runs only inside its HTTP router, which is not mounted. What remains: better-auth's two-factor lockout (`failed_verification_count`, `locked_until`), five attempts per two-factor sign-in, and a 60-second resend throttle for verification mail, kept in memory on globalThis. **Risk:** sign-in, sign-up and reset requests are not throttled; add a limiter at the proxy or on POST `/auth/*` before the beta widens.
14. **Deviation: mail text is English only.** Core cannot read web's catalogues.
15. Smaller departures from the mock:
    - The under-16 page says "contact the site's support" without a link (there is no support page yet).
    - The verify page has no "Change email" link (change-email is not built), and resend has a server-side 60-second throttle instead of a countdown.
    - Sessions show browser, system, masked IP and dates, but no location (no GeoIP).
    - The verified state links to the feed instead of redirecting.
    - The admin page shows the kill switch and the cap read-only; there is no "Pause registration" button, since writing settings is ADM's job.
16. **Deviation: contract changes in my own schema files.** `InviteGate` and `InviteCheck` in `s/invite.ts` were unused and are replaced by `InviteLookup`, `InviteRow`, `InviteStatus`, `Handle` and `InviteCreateBody`. Redeeming happens inside `account.register`'s transaction, so a separate `redeem()` would break the single transaction. `s/session.ts` gains `DeviceSession`, and its doc says `siteRole` needs two-factor.
17. **Deviation: route files.** They sit in directories (`settings/account/index.tsx`, `settings/security/index.tsx`, `admin/registration/index.tsx`) so that every file is inside the write set's `settings/account/**`. The URLs are still `/settings/account` and so on. Sign-out is `POST /auth/sign-out` (`routes/auth/sign-out.ts`).
18. **Progressive enhancement:** every form is a plain POST to its own route. Without JavaScript, the server answers 303, or redirects back with `?error=<code>`. Once hydrated, `AuthForm` posts by fetch with `Accept: application/json` and keeps what was typed. Cross-site posts get 403 (checked by the Origin host or `Sec-Fetch-Site`). Personal pages answer with `Cache-Control: private, no-store`; the invite page also sends `x-robots-tag: noindex`.
19. **Deviation: web uses native inputs.** The `@peblish/ui` facade exports only `Button`, which these pages use for every button. Inputs, selects and checkboxes are native, styled in `routes/auth/-ui/auth.css` with Mux semantic tokens. Mux's reset sets `appearance: none` on native checkboxes; `.chk` restores it.
20. Error codes on the pages are the refusal reasons these flows can meet, plus web-only codes (`credentials.invalid`, `password.wrong`, `two_factor.*`, `reset.invalid`, `mail.failed` and others). The list is `routes/auth/-ui/errors.ts`, with `error.<code>` messages in `i18n/auth.json`.

## Requests to root

1. **Migration.** Commit 021115b adds `packages/core/drizzle/0002_age_declarations.sql`, `packages/core/drizzle/meta/0002_snapshot.json` and their journal entry. drizzle-kit generated them from `packages/core/src/identity/tables.ts` only so this branch's tests and e2e can run. Drop that migration and regenerate at integration (`pnpm db:generate`), or fold the table into 0001.
2. **`packages/schema/src/site-settings.ts`**: add the cap key, decided on 2026-11-08:
   ```ts
   /** Beta cap on accounts: local people with a login who have not deleted it. Sign-up refuses at the cap. */
   'registration.cap': { schema: type('number.integer >= 0'), default: 25 },
   ```
   Then `packages/core/src/registration/settings.ts` should take the schema and default from the contract: `contract['registration.cap']` instead of its local `RegistrationCap` and `DEFAULT_REGISTRATION_CAP`. Lane A or root can make that one-line swap.
3. **Lockfile:** I ran `pnpm add` and committed the lockfile. Added: `nodemailer` 10.3.1 and `@better-auth/utils` 0.5.1 (the copy better-auth already uses) to `packages/core`; `uqr` 0.1.3 and `arktype` 2.2.9 to `packages/web`. Regenerate at integration.
4. **Deployment** (`deploy/README.md`, CI, image):
   - `BETTER_AUTH_SECRET` is required on any real host (32 characters or more).
   - `SMTP_URL` is required for mail; `MAIL_FROM` is optional and defaults to `<host> <no-reply@<host>>`.
   - The admin bootstrap is a source script (`packages/core/src/identity/admin-cli.ts`, password on stdin). The image needs a way to run it: ship the file, or add a bundled `admin` process.
   - CI e2e needs Mailpit (compose already has it on 18425/18426), `SMTP_URL=smtp://127.0.0.1:18425`, and a migrated `DATABASE_URL`. The flows seed through `node packages/core/src/testing/seed-a.ts e2e-admin` and skip under `BASE_URL`.
5. **Optional:** move `getSessionView` from `packages/web/src/routes/auth/-session.ts` to `packages/web/src/server/session.ts`. Server functions must not share a module with server-only helpers (a client import would pull core into the bundle), and `w/server/auth.ts` is such a module, so it went under my routes.

## Requests to other lanes (through root)

- **AZ, `packages/core/src/authz/principal.ts`:** in the recheck's principal refresh, count an admin as one only with two-factor on (A03), as `SessionView` does. Select `twoFactorEnabled: authUser.twoFactorEnabled` beside `role`, and return `siteRole: user?.role === 'admin' && user.twoFactorEnabled === true ? 'admin' : 'user'`. Today a rechecked admin action (`mod.site_ban`, say) treats an admin without two-factor as admin.
- **B1 and D (post and comment policies):** the mock says an account "cannot post until the address is verified". Deny `post.create` and `comment.create` while `auth_user.email_verified` is false. Read it through the actor's `user_id` and lock it FOR SHARE under lock. Root would add a common refusal for it, such as `'auth.email_unverified'` in `refusals/common.ts`.
- **ADM:** add the controls behind the admin invites page: raise the cap (`registration.cap`) and pause registration (`registration.enabled`) through `c/settings`. An admin "delete this account" action can call `deleteAccountAs(principal, actorId, reason)` from `packages/core/src/identity/delete.ts`. It gives site-admin authority, refuses another admin with `target.protected`, and refuses an admin without two-factor.
- **UI:**
  - The shell's account area can call `getSessionView()` (`packages/web/src/routes/auth/-session.ts`, returns `SessionView | null`) from the root loader. It can link to `/auth/sign-in`, `/auth/sign-up`, `/settings/account`, `/settings/security` and, for `siteRole === 'admin'`, `/admin/registration`, and render sign-out as a form posting to `/auth/sign-out`.
  - When the facade gains text fields, selects and checkboxes, swap the native inputs in `routes/auth/-ui/form.tsx` (`Field`) and the pages.
  - Page `<title>`s are still the shell's.
- **FED-A and FED-B:**
  - New local people get `localActorUrls` endpoints (inbox, outbox, followers, shared inbox) and an RSA-2048 key, `keyId <ap_id>#main-key`, in `actor_keys`.
  - `actor.deleted` (`kind 'Person'`, `local true`) is emitted when an account is deleted. The actor keeps its ap_id, endpoints and key, so the `Delete` can be signed. Its follows are untouched.
  - `account.registered` and `actor.created` are emitted at sign-up.
- **M31:** sign-up links to `/terms`, `/privacy` and `/rules`.

## Left for later

- A general rate limiter (decision 13).
- Change of email.
- Localized mail.
- Own-content export before deletion.
- An admin UI to delete someone else's account (the service exists).
- Showing the kill-switch state on the sign-up page before submitting.
