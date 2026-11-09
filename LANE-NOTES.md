# Lane MODF notes

Branch `mvp-w3-modf`, worktree `feddit-mvp-w3-modf`, port 18320. Base tag `w3-groundwork`.

## 1. What landed

| Deliverable | Where | Proof |
| --- | --- | --- |
| Site bans: `site_bans` table, `banFromSite` and `unbanFromSite` (one `mod.ban` with `communityId: null` and `removeContent`, removal through the per-post path a community ban uses), the `auth.site_banned` principal seam | `core/src/bans/{tables,site}.ts`, `core/src/authz/actions/bans.ts`, `core/src/authz/principal.ts` | `bans/site.test.ts` (interleavings against `createPost`, role by target tables, precheck and recheck) |
| Peer controls: `peer_controls` table, `updatePeer`, every new peer starts with media quarantined, the real `c/peers/gate.ts` (signatures unchanged), the blocked-peer feed predicate | `core/src/peers/**`, `core/src/authz/actions/peers.ts` | `peers/{gate,update,feed-predicate,read}.test.ts` |
| Inbound site ban from Lemmy and PieFed (`Block` with the instance actor as target, `Undo`, origin rule, 2100 as permanent), 503 on a paused inbox, 403 on a blocked peer, proxy 404 for quarantined media | `federation/src/inbound/**`, `web/src/routes/media/proxy/-handler.ts`, `core/src/media/image-src.ts`, `web/src/server/markdown.ts` | `inbound/{site-ban,peer-controls}.test.ts`, handler and markdown tests |
| Modlog page (`modlog-feed`): keyset cursor on `(created_at, id)`, filters, action groups, facets, audiences (public, moderator, admin), `settings.*` and `page.*` rows from ADM, withheld reasons for untrusted instances | `core/src/modlog/**`, `schema/src/modlog.ts`, `web/src/routes/modlog/**`, `web/src/i18n/modlog.json` | `modlog/page.test.ts`, `-ui/labels.test.ts`, `e2e/modlog` |
| Remove, restore, ban, unban, site ban, site unban as authorize-then-mutate services; `POST /modlog/act` | `core/src/bans/service.ts`, `web/src/routes/modlog/{act.ts,-act.ts}` | `bans/read.test.ts`, `-act.test.ts`, `e2e/modlog` |
| The three `moderate.tsx` slot kinds (post, comment, profile) and the community one, sharing one set of panels | `web/src/routes/{post,post/$id/comments,u,c}/-ui/actions/moderate.tsx`, `modlog/-ui/{content-moderate,panels}.tsx` | `e2e/modlog` |
| `admin-tabs`: Bans tab and Peers tab | `web/src/routes/admin/{bans,peers}/**`, `web/src/i18n/{bans,peers}.json` | `e2e/bans`, `e2e/peers`, `peers/-act.test.ts` |
| E2e seed | `core/src/testing/seed-modf.ts` (`node packages/core/src/testing/seed-modf.ts e2e`) | used by the three specs |

## 2. Commits

```
1a83167 Add site ban and peer control tables, the peer gates and updatePeer
17049ed Add site bans: the policies, banFromSite and unbanFromSite, the principal seam
00765c1 Federate site bans inbound and wire the peer gates
394f442 Add the modlog page: keyset reads, facets, target labels and /modlog
2692b11 Add the moderator remove, restore and ban flows, the Bans and Peers admin tabs and the moderate slots
```

Plus the commit that adds this file.

## 3. Verification

- `pnpm check`: 2,162 passed, 4 skipped, 14 failed in the last full run (172 files). The 14 are not caused by this lane:
  - 11 in `core/remote/backfill.test.ts` (5) and `federation/backfill/backfill.test.ts` (6): the tests hardcode `now = 2026-11-09T12:00:00Z` while the queue stamps `next_attempt_at` with the database `now()`. Today is past that instant, so nothing is due and `claim` returns null. They pass only when run before 12:00 UTC on 2026-11-09. Root should move the fixed clock forward or derive it from `Date.now()`.
  - `outbox/worker.test.ts` (type filter), `inbound/receive.test.ts` (too much waiting in `inbox_raw`) and `nodeinfo/client.test.ts` (bounded failure map) are timing tests that fail with a load average of 30 to 50 on this machine. They pass in isolation (58 of 58 across those three files).
- `pnpm build && pnpm e2e`: 232 passed, 1 skipped (baseline was 218 passed, 1 skipped).
- Payload budget (in the e2e run): `/admin/bans` and `/admin/peers` 126.3 kB script of 170, `/modlog` 62.8 kB.
- Opt-in: `PEBLISH_FEED_PERF=1` runs the 100k-row feed predicate check. `modlog/page.test.ts` has an opt-in 100k-row cursor read.
- `git status` shows nothing under `packages/core/drizzle/`. The scratch migration is `0008_modf.sql`.

## 4. Decisions and deviations

1. A site ban emits one `mod.ban` with `communityId: null` and a `removeContent` flag, as `decisions.md` asks. Removal goes through the same per-post path as a community ban with removal.
2. Outbound site-ban `Block` is lane FED-C's. This lane owns only the inbound side.
3. Lemmy and PieFed send site bans as `Block` with a target path of `/`; the receiver treats that as the instance actor and applies the origin rule only. An expiry of 2100 or later is stored as a permanent ban.
4. Pause affects intake only (503, `Retry-After: 300`). Block affects intake (403), delivery, the media proxy and feeds. Quarantine and purge affect media only.
5. The blocked-peer feed predicate is uncorrelated hashed subplans. The first, correlated form doubled the Hot feed cost under load.
6. `/modlog/act` lives in `web/src/routes/modlog/act.ts` and the Peers POST handler is in `admin/peers/index.tsx`, as the Bans tab posts to `/modlog/act`.
7. Mod panel styles are inline `<style href precedence>` from `mod.css?inline`. A linked stylesheet with `precedence` hid the page without JS during streaming.
8. Native checkboxes in the panels are restyled in `mod.css` because the Mux reset sets `appearance: none`.
9. The e2e specs call authenticated endpoints from the page (`page.evaluate(fetch)`), because the `__Secure-` session cookie is not sent by `page.request`. `seed-modf` creates its own admin per world so parallel specs do not share a TOTP.
10. Deviation: I appended `/admin/bans/`, `/admin/peers/` and `/modlog/` to `e2e/payload/routes.ts` and `/modlog/act` to `notPages`, as `lane-launch.md` says, although `common.md` lists that file as root's. Root should accept or adjust these lines at integration.

## 5. Requests to root

- `e2e/payload/routes.ts`: keep the three routes and the one `notPages` entry above.
- Migration `0008_modf.sql` (scratch) holds `site_bans` and `peer_controls`; fold them into the wave's single migration. Regenerate after merging other lanes' tables.
- Fix the hardcoded clock in the backfill tests (section 3).
- `schema/src/refusals/{bans,peers}.ts` and `schema/src/events/peers.ts` are new files; if the registry needs a barrel entry beyond the glob, add it.

## 6. Requests to other lanes, through root

- FED-C: outbound site-ban `Block` should read `site_bans` rows written by `banFromSite` and the single `mod.ban` event with `communityId: null`; the `removeContent` flag is on the event.
- ADM: the modlog renders `settings.*` and `page.*` actions through `modlog/describe.ts` and `groups.ts`; new action names need a line there and a label in `modlog/-ui/labels.ts` plus `i18n/modlog.json`.

## 7. Dependencies added

None.

## 8. For later lanes

- `core/peers/gate.ts` is the one place that answers intake, delivery, media and feed questions about a peer; call it rather than reading `peer_controls`.
- The moderate slots render `ContentModerate`, `ProfileModerateTools` and `CommunityModerateTools` from `modlog/-ui/content-moderate.tsx`; add actions to the shared panels, not to each slot.
- A modlog audience is `{admin, moderates}`; add a new visibility rule in `modlog/page.ts`, not in the route.
- A revocation recorded as an INSERT first takes FOR NO KEY UPDATE on its parent row. For a site ban that is the target actor row; the principal refresh takes the acting actor FOR SHARE.
- E2e on a world that other specs share: scope assertions by community or person, because the modlog is global across runs.

## 9. Left open and risks

- Timing tests under heavy machine load can still flake (section 3).
- No traffic was sent to any real fediverse server; the Lemmy and PieFed behaviour is from fixtures. The lab check of site-ban `Block` interop is LAB's.
- The Bans tab counts live posts and comments for the removal prompt; a very large account could make that count slow. It is one indexed count per kind.
