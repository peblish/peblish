# Lane DISC notes (community directory and resolve)

Branch `mvp-w3-disc` in `/Users/admin/Projects/feddit-mvp-w3-disc`, from the tag `w3-groundwork` (35fbc62), `lane.sh` name `disc`, port 18317. Shorthands: `c/` `packages/core/src`, `w/` `packages/web/src`, `s/` `packages/schema/src`, `f/` `packages/federation/src`.

## 1. What landed

| Deliverable                                                                                                                                                                                  | Where                                                                                          | Proof                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Lookup grammar: a handle (`!name@host`, `@name@host`, `name@host`) or an https link, 500 characters, no credentials; the error codes the form can show                                       | `c/resolve/{parse,outcome}.ts`                                                                 | `c/resolve/parse.test.ts`; `f/resolve/parse.test.ts` holds the copy of `parseHandle`'s grammar to the original                              |
| Block seam (`hostBlocked`, `blockedHosts`), false and empty until root swaps them for MODF's                                                                                                 | `c/resolve/blocked.ts`                                                                         | used and mocked in `f/resolve/limit.test.ts`, `web.blocked.test.ts`, `c/directory/read.test.ts`                                             |
| `findHeld` (database only) and `pointsHere`                                                                                                                                                  | `c/resolve/local.ts`                                                                           | `c/resolve/local.test.ts`                                                                                                                   |
| Directory read: scope, sort, NSFW, search, 25 a page to 500, counts per scope, viewer's follow state, sanitised excerpts                                                                     | `c/directory/{input,read,ref}.ts`                                                              | `c/directory/read.test.ts`                                                                                                                  |
| Budget: first page of every sort, scope, NSFW setting and three searches at 300 communities and `seedBulk`'s 100,000 posts, over 20 runs                                                     | `c/directory/perf.test.ts` (`PEBLISH_DIRECTORY_PERF=1`)                                        | worst p95 17.2 ms (budget 50); the activity count uses `posts_community_published` (plan in the same test)                                  |
| `joinCommunityAs`, `leaveCommunityAs`                                                                                                                                                        | `c/directory/follow.ts`                                                                        | `c/directory/follow.test.ts`                                                                                                                |
| The resolver: one allowance of 12 requests in 15 s (`limit.ts`), a blocked host refused for every request, handle and link paths, post and comment stored under their community's own origin | `f/resolve/{limit,web}.ts`                                                                     | `f/resolve/{limit,web,web.blocked}.test.ts` (stubFetch; the Lemmy 0.19.21 and PieFed 1.8.11 Group documents of the corpus resolve and list) |
| `POST /communities/follow`                                                                                                                                                                   | `w/routes/communities/{follow,-answer}.ts`                                                     | `-answer.test.ts`; e2e                                                                                                                      |
| `/communities`                                                                                                                                                                               | `w/routes/communities/{index.tsx,-load.ts,-ui/}`                                               | e2e: hydration en-US and de-DE, axe, plain links, no age-gated community in the HTML, Join and Leave with and without script                |
| `/resolve` and `POST /resolve`                                                                                                                                                               | `w/routes/resolve/{index.tsx,-resolve.ts,-answer.ts,-load.ts,-ui/}`                            | `-resolve.test.ts` (step order, the 11th networked attempt `rate.limited` with no fetch, answers); e2e                                      |
| Strings, en and de                                                                                                                                                                           | `w/i18n/directory.json` (`directory.*`, `resolve.*`)                                           | key parity by the catalogue test                                                                                                            |
| Seed and e2e data                                                                                                                                                                            | `c/testing/seed-disc.ts` (`seedDirectoryWorld`, CLI `e2e`)                                     | used by the tests above                                                                                                                     |
| Payload routes                                                                                                                                                                               | `e2e/payload/routes.ts`: `/communities/`, `/resolve/`, and `/communities/follow` in `notPages` | `e2e/payload/budget.spec.ts`                                                                                                                |

No table, mutation, event, refusal reason or migration: `s/{refusals,events}/directory.ts` stay empty.

## 2. Commits

| Commit  | Change                                                                   |
| ------- | ------------------------------------------------------------------------ |
| 62f445d | Lookup parser, error codes and the host block seam                       |
| 4898d0b | Directory read, join and leave, directory seed, opt-in perf test         |
| 2134437 | `findHeld` and `pointsHere`                                              |
| 187a594 | The resolver web entry                                                   |
| 5d46048 | `POST /communities/follow`                                               |
| 8801c21 | `/communities` and `/resolve` pages, strings, e2e                        |
| a0ccc7b | The corpus's Lemmy and PieFed Group documents resolve                    |
| 3cb419c | The resolve form is read only for a signed-in person and only when small |
| 54bcaa6 | A Tombstone at a link is gone                                            |
| (last)  | This file                                                                |

## 3. Verification

- `pnpm check`, last fully green at 8801c21 (the pages commit): 168 test files passed, 3 skipped; 2,160 tests passed, 5 skipped (GW3's head had 2,102; DISC adds about 58 before the later commits, 61 in all). Each earlier commit had typecheck, lint and its own tests green; the full run was made at commits 2, 4 and 6.
- The final tree (54bcaa6 plus this file) was run twice and was not green, for reasons outside DISC: 13 failures in `core` and `federation` tests of other lanes. (a) `core/src/remote/backfill.test.ts` and `federation/src/backfill/backfill.test.ts` hard-code `2026-11-09T12:00:00Z` as "now" against the database's own clock, so they fail for good once the real clock passes 12:00 UTC on 2026-11-09 (they passed in my 11:26 UTC run); see request 5. (b) `outbox/worker.test.ts`, `db/migrate.test.ts`, `comments/mutations.test.ts`, `comments/budget.test.ts` and `posts/actions.test.ts` time out when the shared Postgres is busy (load average 20 to 40 from other lanes, `pg_stat_activity` showed no stuck transaction); a different handful fails each run and each file passes when run on its own. Every DISC test passes in both runs.
- `pnpm build && pnpm e2e` on port 18317: 233 passed, 1 skipped, 1 failed. The failure is `e2e/payload/budget.spec.ts` "a page that is neither budgeted nor excused", which names `/communities/` as its example of an unbudgeted page (root's file, request 1; the same run with the example renamed passed and was reverted). One earlier full run also lost `composer.spec.ts` "mentions and images" (a remote picture shown as a link) while `media/proxy.spec.ts` flipped the remote-media kill switch in parallel; the composer specs pass alone (36 passed). The payload budget measured `/communities` and `/resolve` at 126.3 kB of 170 script, 60.4 of 65 CSS, like every page.
- Opt-in: `PEBLISH_DIRECTORY_PERF=1` (and `DIRECTORY_PERF_PLANS=<file>`, `DIRECTORY_PERF_REPORT=<file>`) ran the budget test: 71 combinations, worst p95 17.2 ms.
- Scratch migration: none (no tables). Nothing under `packages/core/drizzle/` changed.

## 4. Decisions and deviations

1. Deviation (small): `c/resolve/local.ts` also exports `pointsHere(lookup)`, which says whether a lookup names this server (its host, or an address on its origin). The contract has three functions; an unmatched address of our own is `target.not_found` with no request and no count, and the handler needs to know that between `findHeld` and the pause switch. `resolveLookup` asks it too, so the web entry is safe on its own.
2. `findHeld` holds only what can be shown: a deleted or removed post or comment, a deleted person or community, and anything in a community an admin removed, is not held. A stored community that an admin removed answers `target.removed` after the fetch (it is stored, not shown). A local post that was deleted is `target.not_found`.
3. `findHeld` reads this server's own page paths, including `/c/<name>@<host>` and `/u/<name>@<host>` (how a remote actor's page is written here), as the remote handle. A name that a community and a person share answers the community when the handle has no sigil.
4. Mapping of refusals a stored object can end in, beyond "same-named code or logged `generic`": `community.removed`, `community.deleted`, `target.removed` are `target.removed`; `target.deleted` is `target.gone`; `object.local` and `object.not_found` are `target.not_found`; `object.blocked` is `input.invalid`; `object.status`, `object.not_json`, `object.too_large`, `object.id_mismatch`, `object.origin_mismatch`, `object.author_mismatch` and `community.mismatch` are `peer.invalid` (the peer's documents do not hold together). A 200 Tombstone at the link is `target.gone`; any other type that is not an actor, `Page` or `Note` is `object.unsupported`. An Application behind a handle fails the handle's own sigil check (`peer.invalid`); behind a link it is `object.unsupported`.
5. The stored copy of a community decides whether its posts are NSFW-rejected. `resolveRemoteActor` keeps a copy for a day, so a community that turned NSFW within the last 24 hours is still taken until its copy is fetched again.
6. Directory counts: `Local N` and `All N` count the communities each scope would list under the viewer's NSFW setting and the search (not the scope itself). A `q` that parses as a handle or link filters nothing (decided in core, `listCommunities`, as well as shown by the page). `q` matches name, display name and host.
7. The directory's scope, sort and NSFW choices are all links, the search one GET form that carries the non-default choices as hidden fields. The NSFW footnote shows with the NSFW links, that is, only to someone who declared 16+.
8. Joined posts Leave, Pending is a disabled button (the directory offers no way to cancel a pending Follow). Buttons are described by the community's handle (`aria-describedby`), not relabelled, so the name keeps the visible text.
9. `/resolve` loads `communities/-ui/directory.css` (both pages are DISC's); its form's pending line names the host asked, or "the other server" when the text does not parse.
10. `POST /resolve` reads the form only for a signed-in person, and refuses a body that declares more than 4 KB; a signed-out post is answered `auth.required` without reading it.
11. A refused request costs no count: the budget is spent only after sign-in, a verified email, a parseable lookup, a miss in `findHeld`, an address that is not ours, `inbox.enabled`, and a host that is not blocked, in that order (decisions item DISC 3).
12. Tests run `pnpm check` on a shared Postgres. `core/src/db/migrate.test.ts` timed out once at 5 s while other lanes were busy and passed on its own and in the final run; not DISC's code.

## 5. Requests to root

1. `e2e/payload/budget.spec.ts` line 250 (root's file): the self-test "a page that is neither budgeted nor excused" uses `/communities/` as its example of an unbudgeted page, which `/communities/` now is. Rename the example, for instance `unaccounted(['/', '/auth/sign-in', '/healthz', '/nonexistent/'])` and `toEqual(['/nonexistent/'])`. With that change the spec passes (checked locally and reverted); without it `pnpm e2e` has one failure.
2. At integration, swap the two bodies in `c/resolve/blocked.ts` for MODF's `isInstanceBlocked(domain)` and `blockedInstanceDomains()` from `c/peers/`. Both take and return what the seam does (`host` lowercase with its port when it is not the default; the directory leaves a blocked domain out).
3. Payload routes: appended `/communities/` and `/resolve/`, and `/communities/follow` under `notPages` (a POST endpoint).
4. Nothing for migrations, throttle scopes (`resolve` is GW3's), settings keys, dependencies or the dependency-cruiser entry (GW3's, used as is).
5. REM's `core/src/remote/backfill.test.ts` and `federation/src/backfill/backfill.test.ts` (lines 355 and 373) use `new Date('2026-11-09T12:00:00Z')` as "now" and compare it with the database's `now()`; they fail from 12:00 UTC on 2026-11-09 on. Use a clock relative to the real one (or set the rows' times from the same constant). Every lane's `pnpm check` is red on them today.

## 6. Requests to other lanes, through root

- COMM: `/c/<name>@<host>` must find a remote community by its handle (`readCommunity` takes an id or a local name today); a resolve of a remote community redirects there. Join and Leave on the community page may post to `/communities/follow` with `community` (the actor id), `intent` (`join` or `leave`) and `next` (a path on this site); the answer is a 303 to `next` (with `?error=<reason>` on a refusal) or JSON `{ ok }` or `{ error }` when asked with `Accept: application/json`. `w/routes/communities/-ui/follow-form.tsx` is the hydrated form (fetch, then `router.invalidate()`) if COMM wants to reuse it.
- E1: `/u/<name>@<host>` must serve a remote Person; a resolve of a person redirects there.
- LAB: resolve a Lemmy, a PieFed and an Mbin community and a post URL against the lab, and record what `/post/<id>` serves for another server's author (decisions item DISC 2: objects are stored only on their community's origin). Also check a Lemmy comment URL (its `audience` names the community) and note that a Mastodon status, which names no community, is `object.unsupported`.
- MODF: the block seam, above.

## 7. Dependencies added

None.

## 8. For later lanes

- `parseLookup`, `findHeld` and `pointsHere` (`c/resolve/`) are plain database reads; E2's mention linking could use `findHeld` for `@name@host` without any request.
- `resolveLookup(lookup, { fetch? })` (`f/resolve/web.ts`) never throws for a peer's behaviour and answers `{ ok: true, found: Held }` or `{ ok: false, error }`; it does not count against any budget (the caller does), and a test passes a `stubFetch` as `fetch`.
- `listCommunities(query, viewer)` and `parseDirectorySearch`, `resolveDirectoryQuery`, `directoryHref` (`c/directory/`): the address's parts are validated leniently, so a stale link still opens the list.
- A new resolve error code goes in `resolveErrors` (`c/resolve/outcome.ts`) and in `directory.json` as `resolve.error.<code>`; a new follow refusal in `directoryErrors` (`w/routes/communities/-ui/errors.ts`) and `directory.error.<code>`.

## 9. Left open and risks

- Nothing here was run against a real server. Lemmy 0.19.21 and PieFed 1.8.11 Group documents from the corpus resolve through stubs; Mbin, and a Lemmy post and comment through the lab, are LAB's (section 6).
- `/c/<handle>` and `/u/<handle>` for a remote actor do not exist on this branch until COMM and E1 land, so a resolve redirects to a 404 there for now (the e2e only checks where it redirects).
- A remote community's own subscriber and post totals are stored nowhere, so the directory shows this server's figures and says so in its footnote; a remote community nobody here joined shows 0 and 0.
- The resolve budget is per process of the database counter, not per fetch: a lookup is one count for up to 12 requests (GW3 request 2).
- A lookup runs in the web request and can take up to 15 seconds; there is no queue and no backfill after it.
