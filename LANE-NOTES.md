# Lane COMPOSER notes (wave 2)

The post composer as a page (`/submit`), as a bottom sheet over the feed, with the Markdown editor, link previews, drafts and the author's edit form. Plan row C15. Branch `mvp-w2-composer` (from `mvp-w2` at e886daf), worktree `/Users/admin/Projects/feddit-mvp-w2-composer`, port 18314, database `peblish_composer`.

## 1. What landed

| Deliverable                                                                                                                            | Where                                                                                                   | Proof                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/submit` page: community list, rules and posting warning beside the form, Text, Link and Image types, title counter, NSFW, Posting as | `packages/web/src/routes/submit/` (`index.tsx`, `-ui/*`, `-load.ts`)                                    | `e2e/composer/composer.spec.ts`: hydration marker, axe, picker, rules aside, restricted community disabled for a plain account and enabled for a moderator                           |
| The sheet: same form, slides up over the feed, feed still mounted, lazy                                                                | `shell/create-post.tsx`, `routes/submit/-ui/composer-sheet.tsx`, `packages/ui/src/composer/sheet.tsx`   | `e2e/composer/sheet.spec.ts`: over the page (URL and content unchanged, panel on the bottom edge), axe open, Escape keeps a draft and returns focus, post from the sheet, ctrl-click |
| Editor: facade textarea plus toolbar (B, I, S, link, quote, code, lists, heading, spoiler), Write and Preview as a toggle pair         | `packages/ui/src/composer/{markdown-editor.tsx,insert.ts}`                                              | `insert.test.ts` (selection and caret for every button); `composer.spec.ts`: bold at a selection, Ctrl+I, spoiler, and Undo after a button                                           |
| Preview equals published                                                                                                               | `previewBody` in `-load.ts` calls `createMarkdownRenderer().render`, the renderer the post page uses    | `composer.spec.ts`: three bodies (spoiler, table, code, links; footnotes, lists, quotes, raw HTML; mentions, remote and own images) byte for byte, and an edit exactly               |
| Submit: preview then `createPost`, refusals by exact reason, then the new post                                                         | `-submit.ts` (`submit`, `parseSubmission`, `readSubmission`, `answer`), the POST handler in `index.tsx` | `-submit.test.ts` (steps with their calls faked), `composer.spec.ts` (banned, unverified, restricted), `nojs.spec.ts`                                                                |
| Without JavaScript: type switch by CSS, plain post, refusal back to the form with the typed text                                       | `submit.css` (`:has()`), `-kept.ts`                                                                     | `e2e/composer/nojs.spec.ts`, `-kept.test.ts`                                                                                                                                         |
| Drafts in the browser per community                                                                                                    | `-ui/drafts.ts`                                                                                         | `composer.spec.ts` (save, restore on choosing the community, discard), `sheet.spec.ts` (dismiss)                                                                                     |
| Edit: `/submit?edit=<postId>` for the author, `updatePost`                                                                             | `-load.ts` (`editTarget`), `-submit.ts`                                                                 | `composer.spec.ts`: edit and Preview with the published footnote ids; a non-author, a missing post                                                                                   |
| Image type disabled with the mock's copy while `uploads.enabled` is off; the upload path behind the switch                             | `-ui/composer.tsx`, `-submit.ts`                                                                        | `e2e/composer/uploads.spec.ts` (off: disabled, no file input, server refuses with `site.disabled`; on: real MinIO, bad file, too large, a posted image)                              |
| Payload                                                                                                                                | `e2e/composer/payload.spec.ts`                                                                          | section 3                                                                                                                                                                            |
| Strings (en, de)                                                                                                                       | `packages/web/src/i18n/composer.json`                                                                   | `-types.test.ts`: same keys in both languages, a message for every error code                                                                                                        |

No `TextEditor`, no Markdown library in the browser, no dependency added.

## 2. Commits

| Commit  | Change                                                           |
| ------- | ---------------------------------------------------------------- |
| fe4ff0a | Add the Markdown editor and the bottom sheet to ui               |
| 56784f5 | Add the composer page, its form and the server half              |
| adcfa2e | Open the composer as a bottom sheet from the shell               |
| f47361d | Add the composer e2e specs and their seed                        |
| 2c04129 | Word the deleted-target refusal for communities as well as posts |
| 8731102 | Refuse a throttled link preview with rate.limited                |
| (this)  | LANE-NOTES.md                                                    |

Nothing here needs to merge early.

## 3. Verification

On the final tree, lane `composer`, `PEBLISH_UI_KIT=1`:

- `pnpm check`: green. 105 test files passed and 1 skipped, 1,504 tests passed and 2 skipped (FIT's), no boundary violations (528 modules), oxlint and Prettier clean. Baseline was 1,481; mine are 23: `insert.test.ts` 5, `-fields.test.ts` 5, `-kept.test.ts` 2, `-submit.test.ts` 9, `-types.test.ts` 2.
- `pnpm e2e` on port 18314: 126 passed, 1 skipped (the `/kit`-off test). Mine are 27: `composer.spec.ts` 14, `sheet.spec.ts` 5, `nojs.spec.ts` 4, `uploads.spec.ts` 2, `payload.spec.ts` 2, on top of the 99 passed and 1 skipped of wave 2's integration.
- `git status` is clean under `packages/core/drizzle/`: no table, no migration.

### Measured payload (first visit, cold cache, gzip -9, kB of 1,000 bytes, excluding app code)

| Route                | React and Mux JS (budget 170) | Editor chunk (budget 200) | Mux CSS (65) | Fonts (270) |
| -------------------- | ----------------------------- | ------------------------- | ------------ | ----------- |
| `/submit`, signed in | 128.9                         | 0.0 (none exists)         | 60.4         | 259.2       |

The sheet's lazy code, loaded when the link is pointed at or opened: +105.1 kB of JavaScript (7 files, the dialog, the editor, the form) and +1.5 kB of CSS, of the 200 kB the budget allows. The page before it opens loads none of the sheet's own chunks (the spec asserts that). Fonts are 259.2 because the toolbar's italic I and the monospace textarea load the italic and code faces: 10.8 kB of room.

`/submit` signed out is a redirect to sign-in, so a signed-out entry in `e2e/payload/routes.ts` measures the sign-in page (126.4). The real figures come from `e2e/composer/payload.spec.ts`, which signs in first and measures with a fresh cache.

The change moved one existing figure: `/kit` is 168.2 kB of 170 (it was 166.3 on `mvp-w2`). No module was added to it: the sheet is one more lazy entry, so the entry-aware `vendor-mux` group splits into six chunks instead of four, and gzip does worse on more, smaller files. `/`, `/auth/sign-in` and the post page did not move. The kit now has 1.8 kB of room. I tried `entriesAwareMergeThreshold: 20_000` on the groups in `vite.config.ts` (root's file, not committed): it merged the React chunks and gave back 0.6 kB (kit 167.6), and left `vendor-mux` as it was.

## 4. Decisions and deviations

1. **(Deviation) The community picker is a list of radios with a filter box, not the mock's dropdown listbox.** A radio list is a real form field, works before hydration and without JavaScript, and needs no custom listbox code or the 60 kB Mux `Select`. It stays open, as the mock's page variant shows it. Pasting `!name@host` for a community that is not followed needs the resolver (lane DISC), so it is not offered; the filter matches handles only.
2. **(Deviation) Remote communities are the ones the person follows with an accepted follow** (`followedCommunities`, lane FED-A). That function returns no host and no posting restriction, so the handle's host is the host of the community's `ap_id` and a remote community's restriction is not known to the picker: such a community is listed enabled, and a post to a restricted one is refused as `community.posting_restricted`. Once a community is chosen its panel (`readCommunity`) does know the flag and the form says so and disables Post. Request 3 below fixes both properly.
3. **Link previews run when the person posts, not while typing.** The server throttles the request (`attempt('link-preview', { ip, id })`), then calls `fetchLinkPreview(principal, url)`, then `createPost` outside any transaction. Per the coordinator's contract note, a request over the budget is refused as `rate.limited`: JSON status 429, or a 303 back with the code, like lane A's forms. `site.disabled` (previews off) is not a refusal: the post goes ahead without a preview. A new link post may leave the title empty and takes the page's title; if the page gave none the form asks for a title (`title.required`). The preview's `thumbnailUrl` and `urlContentType` go to `createPost` as they are, because B2's fix validates them. On this tree, before that fix merges, a hostile `og:image` address that `NewPost` rejects makes the post fail with `generic` instead of posting without a picture.
4. **The body is a Text-post field, as in the mock;** a link post has none. Editing a link post leaves an existing body untouched.
5. **Preview of a new post differs from the published page in footnote anchor ids only.** The page renders with `idPrefix` equal to the post id, which does not exist yet. The e2e normalises `fn-<id>-1` to `fn1`; an edit passes the post id, and its Preview equals the page exactly (also tested).
6. **The Image type is built behind `uploads.enabled`,** not just disabled: a file input and alt text, `uploadImage` (B2), then a post whose `url` is `<origin>/media/<id>` with the saved type. Nothing serves `/media/<id>` until lane SAFE lands, so such a post shows a broken image; that is why the switch stays off. If the post is refused after the upload, the `media` row stays `pending` with no post (the same orphan class as B2's). `PostView` has no `altText`, so alt text cannot be edited.
7. **The sheet is not a route.** It is state in the shell: no URL change, the page underneath stays mounted, and it closes on any navigation. Its code is one lazy chunk; pointing at the link or focusing it starts the load early. It starts in the community whose page is open (`/c/<handle>`, matched among the picker's communities). A dismissed sheet with writing in it saves the draft (one rolling draft per community, one for none yet), so Escape never loses a post. The panel unmounts on close, so there is no exit animation (Mux fades only its own).
8. **Without JavaScript** the type radios switch their fields with `:has()` (Chrome 105, Safari 15.4, Firefox 121 and later); the toolbar, Preview and the draft buttons stay disabled until the page hydrates (`useHydrated`). A refusal answers 303 to `/submit?error=<code>&kept=<base64url JSON>`, and the form comes back with the typed title, link, type, community and flag, and the body when it is 2,000 characters or fewer (a URL cannot carry more). A signed-out post goes to the sign-in page and back with the same parameters.
9. **The POST body is bounded here, not by the framework:** read in pieces and dropped at 1 MiB (4 bytes a character for a 50,000-character body, and slack), plus the upload limit while `uploads.enabled` is on. Too large is `media.too_large`; a body that is no form is `generic`.
10. **The editor** inserts through `document.execCommand('insertText')` so the browser's Undo works after a button (tested in Chromium); where it refuses, the controlled value does the job. Shortcuts: Ctrl or Command with B, I, K; with Enter in the text, submit. A button with a symbol (B, I, S, 1., H) hides the symbol from assistive technology and exposes the name in visually hidden text, because an `aria-label` that does not contain the visible text fails axe's label-in-name rule.
11. **The Mux `Toolbar` is restyled flat** (its pill and border are overridden in the `app` layer) to match the mock.
12. **The page title** is set from the route's loader (`parentMatchPromise` for the locale), because `shell/title.ts` has no `/submit/` entry; the edit page is "Edit post".
13. **No post-level Spoiler flag, no NSFL choice:** `sensitive` (NSFW) is the only flag, as the root decisions say. In an age-gated community the NSFW box is checked and disabled, and the picker lists age-gated communities only for someone who declared 16+ (`ageDeclaredAt`).
14. **E2E seed** is `e2e/composer/seed.ts` (inside my write set), importing core's test seeds by relative path; `e2e/` is outside the boundary lint. `node e2e/composer/seed.ts uploads on|off` writes the `uploads.enabled` row directly (lane ADM is the only product writer) and makes sure the MinIO bucket exists. `uploads.spec.ts` resets the switch in `beforeAll` and `afterAll`, and is the only composer spec that looks at the Image type. Each e2e run spends about 3 of the 30 link previews the link-preview budget allows a client address in ten minutes (the e2e client is one address): many runs in a row can meet `rate.limited` on the link-post tests.
15. **Strings:** B2's media refusals are reused from `media.json` for the three media codes and for `site.disabled` (the upload switch); everything else is in `composer.json`. The body limit in the copy is `markdownMaxLength` (50,000), not the mock's 40,000.

## 5. Requests to root

1. **`e2e/payload/routes.ts`:** add `{ path: '/submit', composer: true }` to `routes`. Signed out it follows the redirect and measures the sign-in page (see section 3); my own `payload.spec.ts` carries the signed-in figures. If you would rather the shared check measure a signed-in visit, `PayloadRoute` needs a way to start from a session (a `storageState` option in `firstVisit`); I did not touch `e2e/payload/**`.
2. **README ownership table, a COMPOSER row:** `packages/ui/src/composer/**`, `packages/web/src/routes/submit/**`, `packages/web/src/shell/create-post.tsx` (handed over from UI), `packages/web/src/i18n/composer.json`, `e2e/composer/**`.
3. **Optional, `packages/core/src/follows/read.ts` (FED-A's):** `followedCommunities` should also return the community's host (`instances.domain`, one `innerJoin`) and `postingRestrictedToMods`, so the picker can print the handle as the rest of the app does and disable a restricted remote community for a non-moderator. `-load.ts` `pickable()` is the only caller to change.
4. **Optional, `packages/web/vite.config.ts`:** `/kit` has 1.8 kB of room (section 3). If the kit is meant to keep growing, either raise its share of the budget or look at what merges the `vendor-mux` subgroups; `entriesAwareMergeThreshold` alone did not.
5. **Optional, UI's facade:** Mux's `Dialog` close button has the hard-coded label "Close dialog" (English), so the sheet's close button is English in the German locale. `DialogProps` has no prop for it (`closeClassName` only).
6. **After the B2 fix merges:** nothing in this lane fails to compile before or after it. It uses `fetchLinkPreview(principal, url)` and `attempt('link-preview', ...)` as they are on `mvp-w2`.
7. **Cross-lane side effect to know about:** my local rebuild script and one build experiment ran `pkill -f packages/web/.output/server/index.mjs`, which matches any lane's server started with that command (Playwright's `webServer` starts it that way). If another lane's e2e or dev server stopped unexpectedly while this lane was running its builds, that may have been me. I now stop my server by port.

## 6. Requests to other lanes, through root

- **C1, DISC (community pages):** link "Create post" on a community page to `/submit?community=<id or handle>`; the id or handle must be one the picker lists (a local community, or a remote one the person follows). The shell's sheet already starts in the community of an open `/c/<handle>` page.
- **D (comments):** `MarkdownEditor` (`@peblish/ui/composer/markdown-editor`) is reusable for the comment box in the mock: `name`, `value`, `onChange`, `labels` (`useEditorLabels()` in `-ui/labels.ts` shows the shape), `insertSpoiler` (core's, with a title), `renderPreview` (a server function; `previewBody` takes `postId` as the footnote prefix, a comment would want its own variant), `rows`, `onSubmitShortcut`. It carries no payload beyond Mux's `Toolbar` and `TextArea`.
- **SAFE:** composer posts with `uploads.enabled` on link `<origin>/media/<mediaId>` with `urlContentType` from the saved row; serve that path for clean rows. The upload row has no post until the post is created.
- **ADM:** flipping `uploads.enabled` on is all it takes for the Image type to turn on: the radio, the file input and the larger body limit follow the setting on every request.

## 7. Dependencies added

None. `pnpm install --frozen-lockfile` at the start changed nothing.

## 8. For later lanes

- Server pieces (web only): `loadComposer` (the picker, the chosen community's panel, the post being edited), `loadCommunityPanel`, `previewBody` in `routes/submit/-load.ts`; `parseSubmission`, `submit` (with `Deps`, so its steps test without a database), `readSubmission`, `answer` in `-submit.ts`. A new error code goes in `composerErrors` (`-types.ts`) and `composer.json` (`error.<code>`), and `-types.test.ts` fails until both languages have it.
- `firstProblem` in `-fields.ts` is the one place the field checks live; the browser and the server both call it, so they answer with the same code.
- `useHydrated()` (`@peblish/ui/composer/use-hydrated.ts`) is the effect-free "has the page hydrated" for any control that needs JavaScript.
- Selectors the specs rely on: `label.cmp__type` for the post types, `label.cmp__row` for the community rows, `.pb-md__preview .pb-prose` for the Preview pane.

## 9. Left open and risks

- The positive link-preview path (a page's real title and picture) is covered by the fake-dependency unit tests and B2's own tests, not end to end: `safeFetch` refuses every private address and the sandbox has no public host to stub.
- `document.execCommand` is deprecated but is the only way to keep Undo in a textarea; if a browser drops it, edits fall back to the controlled value and Undo is lost after a button.
- The picker sends every local community (up to 200) and every accepted follow in the page's data. Fine at beta scale; a search-as-you-type server function is the next step.
- A remote community's posting restriction and its remote moderators (lane FED-B's mirror) are not known to the picker; the refusal reason is the backstop.
- No per-account limit on posting itself; only link previews are throttled.
- The sheet's close button label is English in German (request 5).
- In development under React StrictMode the unmount cleanup runs once at mount, which can save a draft from a sheet opened with something in it; production does not.
