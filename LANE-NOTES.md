# FX4-MEDIA lane notes (B07 C1 to C3)

Branch `mvp-w4-fx-media` from `w4-base` (a606db2). `lane.sh` name `safe`, port 18318.

## 1. What landed

| Finding                                                                    | Commit  | Proving test                                                                                                                                                                                                                                                                                                         | Schema change |
| -------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C1: a removed image stays reachable through a saved signed proxy URL       | e96adc9 | `packages/web/src/routes/media/proxy/-handler.test.ts` "a URL signed for content is a 404 once that content is not shown to the viewer" and "a URL signed for no content expires"; `packages/core/src/media/reference.test.ts` (removed, deleted, community removed, NSFW gate per viewer)                           | none          |
| C3: off-host images bypass a supplying peer's media quarantine             | eb66a86 | `packages/core/src/media/proxy-url.test.ts` "an image shown for content a denied peer supplied never loads, wherever it is hosted"; `-handler.test.ts` "an image of content a quarantined, purged or blocked peer supplied is a 404 wherever it is hosted"; `packages/core/src/peers/gate.test.ts` "a supplier: ..." | none          |
| C2: queued Create, Update or Announce goes out after removal or quarantine | 7e1e665 | `packages/federation/src/delivery/recheck.test.ts` (three DB tests fail without the `run.ts` change: removed post across Create, Update, Announce(Create), Announce(Page) with Delete and Undo still delivered; Announce(Create(Note)) judged by comment, post and community; quarantined and blocked upload)        | none          |

- **C1.** A signed proxy reference (`packages/core/src/media/proxy-url.ts`) is now `<head>\n<url>`, signed whole. The head names the content the image was shown for (`p`, `c` or `a` and a uuid: post, comment, actor) or, for text that belongs to no content, a time it expires (`t <seconds>`, the end of the hour after the one it was made in, so a page's URLs stay stable within the hour). The proxy route reads the viewer's session and NSFW cookies and asks `contentShown` (`packages/core/src/media/reference.ts`) on every request: a post must be shown by `readPost` (gate `none`, not deleted, not removed), a comment must be live under a post that is shown or deleted (a tombstone keeps its comments), an actor must be a live community whose `communityGate` is `none` or a person not deleted. Otherwise 404 `no-store`, nothing fetched. No deny list. The web renderer takes `content` as an option of `render` and `sanitize` and a second argument of `image`; every loader that shows content passes it.
- **C3.** The bound head also carries the supplier: the host of the content's ap_id, `-` for this instance's own. `imageSource` derives it from the `apId` the page passes (`ImageContent = { kind, id, apId }`), refuses at render time when the supplier is at or under a `deniedMediaDomains` entry, and refuses content whose ap_id is not a URL. The proxy refuses unless `supplierMediaAllowed` (`packages/core/src/peers/gate.ts`) approves the closest known instance at or above the supplier; unlike `mediaAllowed`, an unknown supplier is refused. The image host and redirect checks are unchanged.
- **C2.** `packages/federation/src/delivery/recheck.ts`: just before the POST (after the lease renewal and the block check) the worker unwraps what a Create, Update or Announce carries (an Announce through an inner Create or Update to its real object, a bare announced object, or a string id) and settles the row `skipped` with `last_error` set when the content is deleted or removed, sits under a gone post or in a deleted or removed community (`heldContent` in `records.ts`, the same rule the served activities use), is a content type no longer held, or the body names an upload of this instance (`<origin>/media/<uuid>`) whose scan state is `quarantined` or `blocked` or whose row is deleted. Delete, Undo, votes, follows and actor Updates go as queued.

## 2. Commits

1. e96adc9 Tie each signed proxy URL to the content it was shown for (B07 C1)
2. eb66a86 Judge remote images by the peer that supplied their content too (B07 C3)
3. 7e1e665 Recheck queued content against its current state before each send (B07 C2)
4. e0cad34 Compare the image a proxy path carries in the composer preview spec (B07 C1)
5. this file

## 3. Verification

- `pnpm check` green before each commit: C1 2,632 passed (9 skipped), C3 2,635, C2 2,639 passed and 9 skipped (233 files, 5 skipped). For C1 the full run stopped at Prettier after build and typecheck passed; after `prettier --write` (whitespace only) `pnpm lint && pnpm test` ran green. No load timeout reruns were needed.
- `pnpm build && pnpm e2e`, final full run: 324 passed and 1 skipped (parallel), 33 passed (serial). The first full run had two failures: `e2e/composer/preview.serial.spec.ts` "mentions and images" (a real consequence of C1, fixed in e0cad34, see decision 10) and `e2e/comments/comments.spec.ts` "rendered in under 200 ms" (best of 5: 216 ms under load; a timing budget, passed when rerun alone and in the final full run). `pnpm check` after e0cad34: 2,639 passed, 9 skipped.
- The C2 tests were run with the `run.ts` change stashed: three of four fail (the fourth tests the parser alone), and pass with it.

## 4. Decisions and deviations

1. **Deviation (write set).** The brief names "the core view mappers that build image references"; the image signer and its callers are in web, not core: `packages/web/src/server/markdown.ts` (the renderer that wraps `imageSource`: its `render`, `sanitize` and `image` gained the `content` argument) and the loaders `routes/post/-load.ts`, `routes/post/-page-data.ts`, `routes/post/$id/comments/-thread.ts`, `routes/index/-feed/items.ts`, `routes/u/$handle/-load.ts`, `routes/c/-load.ts`, `routes/submit/-load.ts`. Only the arguments passed to the signer changed there, plus the types of those arguments, with their tests (`-page-data.test.ts`).
2. **Community sidebar.** `routes/c/-load.ts` used to sign a remote summary's images twice: once in `readCommunityPage` (its hook) and again when the loader sanitised `page.summaryHtml` against the remote ap_id, which resolved the proxy path against the remote host and proxied that (a broken image). The hook is now a pass-through (images stay inline in an intermediate string that never leaves the server) and the loader's own sanitise signs them once, for the community, after its ap_id is known.
3. A removed post's images 404 for moderators and admins too, although they still read the post: root's rule is "refuses when that content is removed", and a takedown should stop the image for everyone.
4. Unbound references (draft preview, legal and site pages, the admin page preview, the kit page) expire after one to two hours instead of living for ever, so a preview cannot mint a permanent proxy URL for an arbitrary image. Pages are rendered per request, so they always carry a fresh one.
5. URLs in the old form (the URL alone, signed) are refused after deploy; pages re-render with new ones, and browsers hold proxied images for at most 10 minutes.
6. The supplier is the content's ap_id host, judged by the closest known instance at or above it, the rule `mediaAllowed` already uses for image hosts. For a remote post relayed by a community on a third instance, the supplier is the post's origin, not the relaying community.
7. C2 skips only `quarantined`, `blocked` and deleted uploads. A `pending` upload still goes (skipping would drop every post sent before its scan ends; peers get a 404 for the image until it is clean), and so does `failed` (its bytes are purged, the image 404s).
8. C2 uses `heldContent`, so a comment under a deleted post is skipped, while the proxy (C1) still shows that comment's images (the post page lists comments of a tombstone). Peers delete the post's thread anyway.
9. A content object type (Page, Note, Article, Question, Image, Video, Event) with no row held is skipped (fail closed); any other unheld object (an actor Update, an announced id we do not hold) goes.
10. **Deviation (write set).** `e2e/composer/preview.serial.spec.ts` compared preview and published HTML byte for byte. A draft's preview signs remote images with an expiring reference and the published post signs them for the post, so the proxy paths now differ by design; the spec's normaliser now compares the image URL each proxy path carries (e0cad34). Nothing else in the spec changed.

## 5. Requests to root

1. `packages/federation/README.md`, the delivery outcomes table (around line 272): add a row "a Create, Update or Announce whose content is deleted or removed, or shows a quarantined or blocked upload, read just before the POST (`delivery/recheck.ts`) | skipped, never retried". The file is outside this lane's write set.
2. `packages/core/src/delivery/tables.ts`, the `deliveries` comment: "`skipped` (the instance is dormant)" now also means blocked (already true) and withheld content. Suggested: "`skipped` (the instance is dormant or blocked, or the content was withheld before the send)".

## 6. Requests to other lanes, through root

None. FX4-FED owns `packages/federation/src/**` outside `delivery/`; nothing there changed.

## 7. Dependencies added

None.

## 8. For later lanes

- Show a remote image through `renderer.image(url, { kind, id, apId })` and pass `content: { kind, id, apId }` to `render` and `sanitize` for any body that belongs to a post, comment or actor. Leaving it out is safe (the URLs expire) but the proxy can then not refuse the image when the content is taken down.
- `contentShown(content, viewer, nsfw)` (`core/media/reference.ts`) is the proxy's content rule; `supplierMediaAllowed(host)` (`core/peers/gate.ts`) its supplier rule.
- A new content activity type the worker sends should be added to `contentTypes` in `delivery/recheck.ts` if it carries a post or comment.

## 9. Left open and risks

- Cost: each proxied image with a content reference now reads the session and the content (readPost is a few queries) before the fetch. A feed page of 25 thumbnails is 25 such reads on top of 25 remote fetches. Fine for the beta; a short in-process cache keyed by (content, viewer) is the lever if it shows.
- The proxy's answer is `private, max-age=600`, so a browser that already holds an image keeps showing it for up to 10 minutes after a takedown or sign-out (unchanged lifetime, now viewer specific).
- C2 rechecks only uploads of this instance named by absolute `<origin>/media/<uuid>` URLs in the body (what core's render produces); a relative reference in `source.content` Markdown is not matched, and peers cannot load it from us either.
