# FR4-MEDIA lane notes (review 2 CN1 to CN3)

Branch `mvp-w4-fr-media` from `w4-fixes` (0f091d7). `lane.sh` name `safe`, port 18318.

## 1. What landed

| Item                                                       | Commit  | Proving test                                                                                                                                                                                                                                                                                         | Schema change |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| CN1: a copied proxy URL keeps another post's authorization | 59c69cf | `packages/core/src/media/proxy-url.test.ts` "a copied proxy path is signed again for the content it is shown in now, never kept as it stands (CN1)"; `packages/web/src/routes/media/proxy/-handler.test.ts` "a URL whose target is itself one of our proxy paths is a 404 and fetches nothing (CN1)" | none          |
| CN2: an escaped upload URL evades the delivery recheck     | d097364 | `packages/federation/src/delivery/recheck.test.ts` "a quarantined upload is found however the body writes its URL: JSON escapes, character references, percent escapes (CN2)"                                                                                                                        | none          |
| CN3: a revealed sensitive feed card's image stays broken   | d40d5a7 | `packages/core/src/media/reference.test.ts` "an image of sensitive content loads for a signed-in viewer with a 16+ declaration, whatever their Hide NSFW choice (CN3)"; `e2e/media/reveal.spec.ts`                                                                                                   | none          |

Each new test fails on the code before its fix and passes after: the core and web unit tests with the fix's source files restored to `w4-fixes`, the CN2 test against the old `recheck.ts` (its first body, `https:\/\/fed-a.test\/media\/<id>`, came back `null`), and the e2e spec against a build made before CN3 (the declared reader's thumbnail answered 404).

- **CN1.** `imageSource` (`core/media/image-src.ts`) now judges the supplier first: content a denied peer supplied shows no image, this instance's own `/media/...` included. Then, for a URL whose path is one the proxy route answers (`isProxyPath`, read in any case and percent-decoded, as a router may read it), it asks the new `policy.unwrap`. That is `unwrapProxyUrl(key, url)` in `proxy-url.ts`: it checks the HMAC under our key whatever host the path is written under, so `www.` or another host name for the instance is caught too, and returns the URL the reference carries. The image is then signed again for the current content and supplier, recursively, so a path wrapped twice is peeled to the image. A proxy path under our origin that does not verify, or with no `unwrap` given, is dropped. Another instance's proxy path is just a remote image. `siteMarkdown()` (`web/server/markdown.ts`) sets `unwrap` with the proxy's key. At the proxy, `proxyResponse` (`-handler.ts`) also refuses a verified target that is itself one of our proxy paths, before any content or supplier read.
- **CN2.** `withheldReason` (`federation/delivery/recheck.ts`) parses the body and walks every string value and key (an explicit stack, no recursion). It decodes one pass of HTML character references (numeric, plus `&sol;`, `&colon;`, `&period;`, `&amp;`) and percent escapes (ASCII only), then matches `//<our host>/media/<uuid>` under any scheme or none, case-insensitively. The serialized-text prefilter is gone.
- **CN3.** `contentShown` (`core/media/reference.ts`) takes no NSFW choice now. It reads posts and communities with `showNsfw`, so only the sign-in and age gates, takedowns and deletions refuse; the supplier check stays in the proxy. The proxy route (`routes/media/proxy/$signature/$target.ts`) no longer reads the Hide NSFW cookies. `PostCard` needed no change: its thumbnail `<img>` is in the page while the card is blurred, so it loads and the reveal only lifts the blur.

## 2. Commits

1. 59c69cf Sign a copied proxy URL again for the content it is shown in (review 2 CN1)
2. d097364 Recheck the media a queued activity names in its decoded strings (review 2 CN2)
3. d40d5a7 Serve a sensitive post's images to any reader who may open it (review 2 CN3)
4. d0c86a5 Media README: the proxy's access rule and copied proxy paths (review 2 CN1, CN3)
5. this file

## 3. Verification

- `pnpm check` before each commit: CN1 2,673 passed, 9 skipped (239 files, 5 skipped); CN2 2,674 passed, 9 skipped.
- CN3: the full `pnpm check` passed build, typecheck and lint, then had 9 test failures in 6 files: `authz/moderators-cache.test.ts`, `comments/mutations.test.ts` (timeouts, and a deadlock in `truncateAll`), `reports/read.test.ts` (timeouts, and a 50 ms budget measured at 80 ms), `federation/inbound/pipeline.test.ts`, `inbound/receive.test.ts`, `nodeinfo/client.test.ts` (timeouts). The load average was about 33 at the time and `pg_stat_activity` showed only another lane's idle sessions. Rerun alone, all 6 files passed (90 tests). The spec changed after that run, so I reran `pnpm typecheck && pnpm lint` (green) before committing.
- The README commit was docs only (Prettier checked). The final full `pnpm check` after it: 2,674 passed, 9 skipped, green with no reruns.
- `pnpm build && pnpm e2e`, final: 325 passed and 1 skipped (parallel), 33 passed (serial). The first final run had one failure, `e2e/composer/composer.spec.ts` "the page hydrates, lists the communities", and it failed again alone. The cause was the lane database: `peblish_safe` had built up 292 live local communities from earlier waves' runs, over the composer's 200-community list cap (`listLocalCommunities`), so the spec's new communities were cut off. My seed adds only remote communities. I recreated the lane's own database the way `scripts/lane.sh` documents (`dropdb --force peblish_safe`, then `sh scripts/lane.sh safe`), and the full e2e then passed. See decision 6.

## 4. Decisions and deviations

1. **CN1, unwrap rather than reject.** Root allowed either. Unwrapping keeps a legitimate copy working (a person pasting an image address copied from a feed into a post) and still signs for the current content and supplier. Unwrapping checks only the signature: an expired or bound head authorizes nothing, because the result is signed again.
2. **CN1, any host.** The check runs on every URL whose path looks like ours, not only same-origin ones: a signature that verifies under our key proves we minted it, so an alias host cannot carry a borrowed authorization through our own proxy.
3. **CN1, supplier first applies to own media too.** Root's "supplier check runs before any own-origin fast path" means a denied peer's post now shows no image even when the image is this instance's own `/media/<id>`. Before, such a URL was returned as a root-relative path.
4. **CN2, more than JSON escapes.** Besides decoding JSON (parse, then walk), the recheck decodes one pass of HTML character references and percent escapes, and matches scheme-relative `//host/media/<id>`. A peer reading the HTML or URL would load those forms, and over-matching only fails closed (a skipped delivery). It still matches only our own host. Relative `/media/<id>` in Markdown source is still not matched (as before; peers cannot load it either).
5. **CN3, e2e shows that the image is fetched, not that it loads.** The proxy refuses private addresses by design and live servers are off-limits, so no real image can load in e2e. The spec uses a loopback stub, as `e2e/media/proxy.serial.spec.ts` does. A 403 from the proxy (the private-address refusal, reached only after every access check passed, with no request reaching the stub) stands for "the thumbnail loads". A 404 is an access refusal. The declared reader's browser request and an in-page `fetch` both get 403. A new context signed in as the declared reader also gets 403 (a control that shows the helper carries a session). Signed out and undeclared, the same URL gets 404. The bytes path to a 200 is `-handler.test.ts`. Requests go through in-page `fetch`, not Playwright's API client, which leaves out the Secure session cookie on this http origin (the first draft's 404s were that, not the gate).
6. **Lane database recreated.** `peblish_safe` (this lane's alone, local dev Postgres, test data only) was dropped and recreated with the documented `lane.sh` command to clear what earlier waves left. Nothing else was touched.
7. **Deviation (write set).** The brief requires an e2e case, which needs files outside the listed write set: a new spec `e2e/media/reveal.spec.ts`, and a `sensitive-thumbnail-post` command in `packages/core/src/testing/seed-b2.ts` (the media seed). Its seed is a sensitive image post with a remote thumbnail from a peer whose media is approved, plus a declared and an undeclared account. Both are test code only. `packages/core/src/media/README.md` (in the write set) was updated.
8. `post-card.tsx` is unchanged (see CN3 above).

## 5. Requests to root

1. The composer's community list is capped at 200 local communities (`listLocalCommunities` default, `routes/submit/-load.ts`). On a long-lived lane or e2e database, `e2e/composer/composer.spec.ts` fails once more than 200 exist. Either let that spec mark earlier runs' communities as removed (as `seed-c1.ts` does for its posts), or have CI and lanes start e2e on a fresh database. Not a product change for the beta (the real instance has few communities), but worth a launch-gaps line if an instance may pass 200.

## 6. Requests to other lanes, through root

None. In `packages/federation/src/**` only `delivery/recheck.ts` and its test changed.

## 7. Dependencies added

None.

## 8. For later lanes

- `contentShown(content, viewer, q?)` has no NSFW argument any more. The proxy judges access (sign-in, age, takedown, supplier); presentation (blur, the gate page, Hide NSFW) is the page's.
- Build an `ImagePolicy` or `SiteMarkdown` by hand only in tests. Without `unwrap`, every proxy path under the origin is dropped. `siteMarkdown()` sets it.
- `unwrapProxyUrl(key, url)` and `isProxyPath(url)` (`core/media/proxy-url.ts`) are the way to recognise our own proxy paths.

## 9. Left open and risks

- A declared reader's browser now loads the blurred thumbnail of every sensitive card it is shown, before any reveal (it always requested it; before CN3 the answer was a 404). This is root's rule (access, not presentation), and the bytes stay behind the blur.
- The same rule means a declared reader with Hide NSFW on can open a sensitive post's image URL directly, although the post page shows them the gate. Root accepted this: Hide NSFW is a browser preference, not an access control.
- CN2's decoding is one pass of each kind. A body that double-encodes (`&amp;#47;`) is read as a parser would read it (one layer), so it is not matched, and a peer would not load it as a URL either.
