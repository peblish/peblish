# FZ-TOOLS lane notes: review 3 cutover fixes (Z2 to Z6)

Worktree `/Users/admin/Projects/feddit-mvp-w4-fz-tools`, branch `mvp-w4-fz-tools` from tag `w4-final`
(d268e4c), `lane.sh` name `b06` (port 18323; no server was started on it). Brief:
`briefs/wave-4/review-3-fixes.md`; findings: `review-3-findings.md`, "Cutover tooling".

| Item | Commit  | Proving test                                                                                                                                                                                                                                                                   | Schema change |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Z2   | fdcf4d6 | `tools/cutover/src/ledger-order.test.ts` "a block and a removal of one hash, interleaved, leave a ledger that replays to the list as it is". Without the fix it fails: the live list keeps the hash, the replay (`reapplyLedger`) takes it off                                 | none          |
| Z3   | 809b238 | runbook only (step 7 item 7, step 9); the curl rule was checked locally against a refused port (exit 7), an unroutable test address (exit 28, connected 0), and a plain HTTP port reached over TLS (exit 35, connected non-zero)                                               | none          |
| Z4   | 9842249 | runbook only (go or no-go items 8 and 9, new section "TLS on the new origin", step 7 items 2 and 5)                                                                                                                                                                            | none          |
| Z5   | 7abf9fe | runbook only (step 7 item 6)                                                                                                                                                                                                                                                   | none          |
| Z6   | b690e8e | `tools/cutover/src/cli.test.ts` "import of a bundle file that is missing / not JSON / of the wrong shape turns the federation switch off and imports nothing" (3 cases, through `node tools/cutover/src/cli.ts import --bundle <file>`). Without the fix all three leave it on | none          |

## 1. What landed

- **Z2, one lock order for list changes.** `blockMedia` (`packages/core/src/mediascan/block.ts`) takes
  the hash lock right after its state check, before it updates the row and draws its ledger id.
  `removeBlockedHash` (`mediascan/list.ts`) reads the entry's value (the policy's recheck already holds
  the entry row) and takes the same hash lock before the delete and its ledger row. `addBlockedHash`
  already locked first. So two changes to one hash commit, and number their ledger rows, in one order,
  and the replay ends where the list did. `hash-lock.ts` states the rule and why the removal's entry
  row lock before the hash lock cannot deadlock. The test holds the hash lock on a third connection,
  starts the block (it waits), starts the removal (it waits too, or without the fix commits), then
  releases; it waits on `pg_locks` for this hash's advisory key, not on time. It replays the ledger
  over the same database with the drill's `reapplyLedger` and requires the list unchanged, then checks
  the ledger order (`hash_added`, `blocked`, `hash_removed`) and the list (empty).
- **Z3, the closure check.** Step 7 item 7 checks ports 443 (`curl -sk`) and 80 with a 5 s connect
  timeout and prints `%{exitcode}`, `%{http_code}` and `%{time_connect}`. It passes only on exit 7, or
  exit 28 with `connected 0.000000`; any HTTP code, any TLS or certificate error (35, 60), 52 or 56,
  and 28 after a connection fail it. The IPv6 address is checked the same way when the origin has one.
  Step 9 repeats the same lines with the same rule.
- **Z4, TLS on the new origin.** A new section before step 6 states the requirement (a certificate
  Andrew's browser and Cloudflare both trust is on the new origin before PieFed stops) and stays "not
  yet rehearsed". Path A, preferred: Let's Encrypt through certbot's Cloudflare DNS plugin on the
  production Easypanel host, with a token limited to DNS edit on the zone. Path B: a Cloudflare Origin
  CA certificate, with a Firefox profile of its own trusting Cloudflare's origin root for the sign-in
  (NSS `certutil`, DNS over HTTPS off so the hosts line counts) and its removal. A check with curl and
  `openssl s_client` runs before step 6 and again in step 7 item 2. Step 7 item 5 first opens
  `/nodeinfo/2.1` in the browser to prove it reached the new origin, and never clicks through a
  warning. Go or no-go item 8 requires the TLS rehearsal to record the path, the date and the install
  method; item 9 requires the certificate on the origin before step 6.
- **Z5, pretest trust.** Step 7 item 6 sets `R` without `--cacert` for path A and with
  `--cacert $S/origin-ca-root.pem` for path B, never `-k`, and says a `000` means rerun with `-sS` and
  stop.
- **Z6, the CLI's import.** New `importBundleFile(path, options)` (`tools/cutover/src/import.ts`) runs
  `federationOff` (committed in its own transaction) before `readBundle`; `importBundle(input, ...)`
  keeps its behaviour, and both share `importChecked`. `cli.ts` `import` calls `importBundleFile`. The
  runbook's step 4 line ("turns the federation switch off itself, in a transaction of its own before
  it reads the bundle") is now true of the file too, so it is unchanged.

## 2. Commits

| Commit  | Subject                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| fdcf4d6 | Take the hash lock before a block's ledger row, and on a hash removal, so the ledger orders them as the list saw them (Z2)                        |
| b690e8e | Turn the federation switch off before the CLI reads the bundle file, so a bad file leaves it off (Z6)                                             |
| 809b238 | Cutover runbook: the firewall closure check passes only on a refused or timed-out connection (Z3)                                                 |
| 9842249 | Cutover runbook: a certificate Andrew's browser and Cloudflare trust is on the new origin before PieFed stops, a DNS-challenge one preferred (Z4) |
| 7abf9fe | Cutover runbook: the pretest's trust follows the certificate used (Z5)                                                                            |
| (this)  | Add the FZ-TOOLS lane notes                                                                                                                       |

## 3. Verification

| Commit  | Check                                                                                |
| ------- | ------------------------------------------------------------------------------------ |
| fdcf4d6 | `pnpm check` green on the first run: 2,701 passed, 10 skipped (243 files, 5 skipped) |
| b690e8e | `pnpm check` green on the first run: 2,704 passed, 10 skipped (244 files, 5 skipped) |
| 809b238 | runbook only: `prettier --check deploy/cutover.md`                                   |
| 9842249 | runbook only: `prettier --check deploy/cutover.md`                                   |
| 7abf9fe | runbook only: `prettier --check deploy/cutover.md`                                   |

- No load timeout and no rerun was needed. The machine's load average was about 9.
- Each proving test was run against the code without its fix and failed as described in the table.
  `packages/core/src/mediascan` (54 tests) and the whole `tools` project (48 passed, 5 skipped before
  Z6) were also run on their own after Z2.
- The drill tests (`drill.test.ts`) skip on this machine (client tools older than the server), as
  before; the Z2 test does not need `pg_dump`, since it replays over the database that wrote the ledger.
- `scripts/check-dco.sh w4-final HEAD` passes. No e2e or lab run (integration runs them). No server was
  contacted; the curl checks used 127.0.0.1 and 192.0.2.1 only.

## 4. Decisions and deviations

1. **Z2's removal keeps the policy's entry row lock before the hash lock.** The recheck in
   `authz/actions/mediascan.ts` (not this write set) locks the entry FOR NO KEY UPDATE before the body
   runs. That is safe: nothing holding the hash lock waits on an entry's row lock (a block's
   `insert ... on conflict do nothing` does not wait on a lock-only row), and the test runs exactly that
   case (the removal holds the row and waits while the block lists). Recorded in `hash-lock.ts`.
2. **Z2's test lives in `tools/cutover`** so it replays with the real `reapplyLedger`, over the same
   database (`reapplyLedger(url, [])`), which needs no backup tools and so runs in CI.
3. **Z2's test asserts that the waiter that came first goes first** (block, then removal, list empty).
   Postgres grants a contended advisory lock in queue order, so this is deterministic; the replay check
   holds for either order.
4. **Z4 places the TLS work before step 6** in a section of its own, because the requirement is "before
   PieFed stops" while `web` is added in step 7. If the install needs the `web` domain, the runbook
   creates the production `web` service with no source before step 6, so nothing runs.
5. **Z4 leaves the install mechanism to the rehearsal record** (a custom certificate on the Easypanel
   domain, or a Traefik certificate file, plus the certbot `--deploy-hook` for renewals). I could not
   confirm Easypanel's certificate options without contacting a server; the runbook makes the record a
   go or no-go item and says the step is a no-go if Easypanel takes neither.
6. **Z4 path B uses Firefox** with its own NSS store: Chrome and Safari take local trust anchors from the
   macOS keychain, which would trust the root outside the profile.
7. **Z3 also checks port 80 and the IPv6 address**, since the firewall closes both ports on both
   families, and treats exit 28 after a made connection as a failure (`time_connect` non-zero).
8. **Z6 keeps `importBundle(input, ...)`** for the existing tests and any caller with a bundle in hand;
   a missing `--bundle` flag or `PUBLIC_ORIGIN` is still a usage error before the database is touched.

## 5. Requests to root

None.

## 6. Requests to other lanes, through root

None.

## 7. Dependencies added

None.

## 8. For later lanes

- Any new write that changes the blocked-hash list takes `lockHash` before it writes its
  `deletion_ledger` row (`hash-lock.ts`).
- The CLI's `import` goes through `importBundleFile`; a new loader of operator files for `import`
  belongs after `federationOff` there.

## 9. Left open and risks

- The TLS section (both paths), the Firefox profile commands and the closure check have not run on the
  real hosts, by design; the TLS rehearsal (go or no-go item 8) is still to do and must record the path.
- Path A's renewal hook is named but not written; the rehearsal records it.
- Known from INT4B and unchanged: a replay re-lists and re-removes a hash, quarantining a clean copy
  uploaded after the removal (fail safe).
