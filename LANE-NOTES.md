# Lane UI notes (wave 2)

Branch `mvp-w2-ui` (from `mvp-w2` at 485f084), worktree `/Users/admin/Projects/feddit-mvp-w2-ui`, port 18305, database `peblish_ui`. Brief: shell, tokens, density and theme, the component facade, the payload budget check and the component gallery.

## 1. What landed

| Deliverable                                                                      | Where                                                                                                                                   | Proof                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Shell: sidebar, top bar, drawer on phones, centred body, account area, skip link | `packages/web/src/shell/{shell,sidebar,account,theme-menu,create-post,menu-dismiss}.tsx`, `shell.css`, mounted from `routes/__root.tsx` | `e2e/shell/shell.spec.ts`, axe in `e2e/shell/a11y.spec.ts`      |
| Shell data contract for C1                                                       | `shell/data.ts` (`ShellData`, `loadShellData()`), `shell/root-data.ts`                                                                  | typecheck; `e2e/shell/shell.spec.ts` (empty lists)              |
| Page title convention                                                            | `shell/title.ts` (`pageTitle`, `titleForRoute`), used by the root `head`                                                                | `e2e/shell/shell.spec.ts` (en and de)                           |
| Display preferences cookie, ArkType-validated                                    | `packages/core/src/prefs/cookie.ts`                                                                                                     | `cookie.test.ts`                                                |
| Density control and its server function                                          | `packages/ui/src/density/density-control.tsx`, `shell/prefs-fn.ts` (`storePrefs`), `shell/prefs.tsx`                                    | `e2e/shell/density.spec.ts`                                     |
| Colour schemes: light, dark, true black (`#000`), system                         | `packages/ui/src/theme/root.tsx`, `tokens/tokens.css`, `shell/theme-menu.tsx`                                                           | `density.spec.ts` (computed `#000` and white), axe in all three |
| Router wired into Mux                                                            | `LocaleProvider` `navigate` and `useHref`; `__root.tsx` passes `openInRouter` and `history.createHref`                                  | `e2e/shell/thread.spec.ts` (Enter on a Mux link)                |
| `PostCard` (Card, Classic, Compact), `VoteControl`                               | `packages/ui/src/components/{post-card,vote-control}.tsx`                                                                               | `density.spec.ts`, `vote.spec.ts` (first tap at 6x CPU)         |
| `CommentThread`, `ReplyBar`                                                      | `components/{comment-thread,comment-tree,reply-bar}.tsx`                                                                                | `thread.spec.ts`, `comment-tree.test.ts`                        |
| Facade modules                                                                   | `components/{link,text-field,text-area,select,checkbox,dialog,toolbar,toggle-button-group,menu,tooltip,toast}.tsx`                      | gallery, axe                                                    |
| Content styles for the Markdown HTML                                             | `components/prose.{tsx,css}`                                                                                                            | gallery section "Rendered content", axe                         |
| Gallery at `/kit` (404 unless `PEBLISH_UI_KIT=1`), G0 demo moved there           | `packages/web/src/routes/kit/**`                                                                                                        | `hydration.spec.ts`, `a11y.spec.ts`                             |
| Locale pruning and named vendor chunks                                           | `packages/web/vite.config.ts`                                                                                                           | `e2e/payload/budget.spec.ts`                                    |
| Payload budget check                                                             | `e2e/payload/{budget.ts,routes.ts,budget.spec.ts}`                                                                                      | runs inside `pnpm e2e`; negative controls below                 |

## 2. Commits

| Commit  | Change                                                                  |
| ------- | ----------------------------------------------------------------------- |
| 1866139 | Add the React Aria locale pruning plugin to web (lockfile on its own)   |
| a251b35 | Add the display preferences cookie                                      |
| 3141217 | Add the Mux UI facade modules and the rendered-content styles           |
| 531ec6a | Add VoteControl, PostCard in three densities and DensityControl         |
| aa3d7b1 | Add CommentThread and the docked ReplyBar                               |
| 4bebf30 | Prune React Aria locales and name the vendor chunks                     |
| 56d3d8c | Add the application shell, the colour schemes and the component gallery |
| ad94095 | Add the payload budget check to the e2e run                             |
| (this)  | LANE-NOTES.md                                                           |

The brief asked to commit groundwork other lanes wait on separately: C1 needs `shell/data.ts`, `PostCard` and `DensityControl`; COMPOSER needs the dialog facade and `shell/create-post.tsx`; D needs `CommentThread` and `ReplyBar`. The components commits (3141217, 531ec6a, aa3d7b1) stand alone, but the shell (56d3d8c) is one commit: `shell/data.ts` and the root loader cannot compile without the rest.

## 3. Verification

On this tree, lane `ui`, `PEBLISH_UI_KIT=1`:

- `pnpm check`: green, 67 test files passed and 1 skipped, 1,112 tests passed and 2 skipped (12 of them mine: preferences cookie 4, comment tree 2, time 3, catalogue parity and plurals 3).
- `pnpm e2e`: 77 tests in 13 files, 76 passed and 1 skipped (the test that `/kit` answers 404 where the gallery is off, which needs a server without `PEBLISH_UI_KIT`). Lane A's auth specs (14) and the server specs (8) pass on the new shell. Mine (55): hydration 11 and locale 3, axe 12 (`/` and `/kit`, light, dark, true black, en-US and de-DE, asserting a German string), density and schemes 6, vote and first tap 3, thread and links 6, shell 7, payload 7.
- First tap at 6x CPU throttling (`Emulation.setCPUThrottlingRate`): 8 cold loads each for the vote arrow and the density control, all taps landed.
- Negative control for the budget: with `@import '@muxui/react/themes.css'` appended to `packages/ui/src/styles.css`, the check fails on all three routes (`Mux UI CSS 89.2 kB`, over 65 kB, and `themes.css rules are in the Mux UI stylesheet`); reverted. The spec also holds two pure controls (a themes.css body, a vendor package in an app chunk).

### Measured payload per route (first visit, cold cache, gzip -9; woff2 as sent; kB of 1,000 bytes; excluding app code)

| Route                                   | React and Mux JS (budget 170) | Mux CSS (budget 65) | Fonts (budget 270) |
| --------------------------------------- | ----------------------------- | ------------------- | ------------------ |
| `/`                                     | 62.9                          | 60.4                | 105.6              |
| `/auth/sign-in`                         | 126.4                         | 60.4                | 105.6              |
| `/kit` (regular, italic and code faces) | 166.3                         | 60.4                | 259.2              |

The kit is the widest route (every facade module at once) and has 3.7 kB of room. The German kit page loads the same Latin slices (259.2 kB). The composer's editor chunk is not measured yet: `vendor-editor` exists in the config and `routes.ts` has `composer: true`, but no route uses it.

## 4. Decisions and deviations

1. **(Deviation) The root loader does lane A's `getSessionView()` itself.** A server function called from inside another one is missing from the production build's function table (`Server function info not found` on every page in `node .output/server/index.mjs`, fine in `vite dev`). `shell/root-data.ts` is one server function that calls `pageSession()`, `negotiateLocale()`, `parsePrefs()` and `loadShellData()` as plain functions, so a client navigation costs one request and the response is `private, no-store`. `i18n/locale.ts` (`getRequestLocale`) is gone; the root loader now returns `{ locale, prefs, session, shell }`, and `useTranslate()` keeps its API.
2. **The root route has `staleTime: Infinity`.** Session, preferences and the sidebar lists change by a full page load (sign-in and sign-out are full navigations), by a preference change (kept in state) or by `router.invalidate()`. A feature that changes the sidebar (subscribe, unsubscribe) must call `router.invalidate()`.
3. **(Deviation) Plain buttons for the vote arrows and the density control, not Mux's ToggleButtonGroup.** The group costs about 38 kB gzip on every route that imports it and the density control is a likely first tap. The facade still exports `ToggleButtonGroup` and `ToggleButton` for routes that can afford them.
4. **(Deviation) The facade text field, select and checkbox sit on Mux's light parts.** Mux's `TextField` (module `fields.js`) costs 37 kB gzip and `Select` 60 kB; with the dialog, menu, tooltip and toast the kit would have been 203 kB. `TextField` is built on `Input` parts (+3.6 kB), `Select` on `SelectNative` (+1.1 kB, the browser's own menu), `Checkbox` on `CheckboxField` (+4.5 kB). `text-area.tsx` wraps Mux's `TextArea` parts as `TextAreaField`. Their props are in section 8.
5. **(Deviation) The shell has no `ToastProvider`.** It costs about 50 kB gzip on every route. A page that raises toasts wraps itself in `ToastProvider` (the gallery does).
6. **The account and appearance menus are `<details>`, not Mux `Menu`.** They work before hydration and without JavaScript, cost nothing in the budget, and keep "Sign out" out of the page until the menu is open (lane A's e2e `getByRole('button', { name: 'Sign out' })` on the settings page would otherwise find two). `useMenuDismiss` adds Escape and outside-press closing.
7. **Plain `<a href>` in `PostCard`, `CommentThread` and the sidebar, and one document listener (`useClientLinks`) opens internal ones through the router.** It leaves alone modified clicks, links with a `target` other than `_self`, `download`, same-page `#` links and other origins; a same-origin path the router does not match is opened with a full page load (`window.location.assign`), so an unbuilt page answers a real 404. Mux `Link` goes through `LocaleProvider`'s `navigate`; both are tested for "navigates in the page, once".
8. **`useHref` is `router.history.createHref`**, as TanStack's own links print their hrefs. `router.buildLocation({ href })` is not typed in 1.170.46 (`href` is accepted by `navigate` only), and the app has no base path.
9. **Colour schemes.** `data-muxui-color-scheme` is Mux's (light or dark); `data-scheme` is the choice (`system`, `light`, `dark`, `black`). True black is the dark scheme with the neutral scale's ends moved (`--muxui-semantic-color-neutral-5: #000`, `-10: #0a0a0a`, `-90: #fff`) in `tokens/tokens.css`. The default is `system`; the server cannot know the OS setting, so an inline script (`systemSchemeScript`, only when the choice is system) sets dark before first paint, and `<html>` has `suppressHydrationWarning`. `applyScheme()` keeps `<html>` in step on the client and follows OS changes while the choice is system.
10. **Cookie.** `peblish_prefs=density=<d>&scheme=<s>`, HttpOnly, SameSite=Lax, one year, Secure when `PUBLIC_ORIGIN` is https. Invalid fields fall back one by one. `storePrefs` refuses cross-site posts with lane A's `sameOrigin`. The default density is Classic.
11. **Stylesheets.** `packages/ui/src/styles.css` is Mux UI's `styles.css` only, linked by the root with `id="pb-mux-css"` (the budget check finds it by that id). Everything else is `packages/web/src/styles.css`, which imports `tokens/tokens.css` and each component's CSS from ui, `shell/shell.css`, and (through the kit route's `head`) `routes/kit/-kit.css`. Both files declare the same layer order.
12. **Vendor chunks.** `vite.config.ts` has three groups (`vendor-react`, `vendor-mux` with the React Aria, React Stately, `@internationalized` and motion code Mux pulls in, `vendor-editor` for Tiptap and ProseMirror) with `entriesAware: true`, so a route loads only the Mux code its graph uses. Chunk file names get long (`vendor-mux~index~...`); the check reads the vendor kind from the prefix. The plugin `peblish:payload-chunks` writes `packages/web/.output/payload-chunks.json` (the packages inside each chunk), and the check fails when a vendor package sits in an app chunk or in another group's chunk.
13. **No italics in code.** The highlight.js comment style is muted, not italic: an italic monospace face is a second 41 kB file and the font budget (259.2 kB for regular, italic and code) has no room. Characters outside the Latin slices (arrows, triangles) would make the browser fetch the 876 kB Inter file; the icons are inline SVG, the fold marker is a drawn glyph, and the check fails on any `.ttf`.
14. **`/` is a placeholder** (title and tagline in a `.pb-page` `<main>`): the brief moved the G0 demo to `/kit`; C1 replaces the file. It keeps `useRouteHydrated()` because lane A's flows wait for the marker there.
15. **Every route renders its own `<main>`; the shell gives the landmarks around it** (`aside` named Sidebar, three named `nav`s, the `header`, and `#pb-main` as the skip target). `.pb-page` (max 940 px, centred) is the page column for feed and post pages; a page that needs more (lane A's settings) sets its own width.
16. **Handles.** Local actors print unqualified (`!news`), remote ones with the host dimmed (`!fediverse@lemmy.world`); the mock also showed `@feddit.com` on local handles in post meta, which this leaves out (the sidebar hides it too).
17. **Compact shows the meta line and the comment count** (the mock hid the count, which left no way to see it); the Compact title is one line with an ellipsis.
18. **`CommentView.counts.comments` is read as the number of descendants.** The tree shows "Continue this thread" and "N more replies" where the list holds fewer replies than that (a branch the server cut) and at the depth cap (default 6 levels, `maxDepth`). Lane D to confirm what `counts.comments` means for a comment.
19. **A deleted comment prints "[deleted]" in place of the author;** a removed one keeps the author and shows "[removed by a moderator]". The server decides what `contentHtml` is for each viewer.
20. **Routes the shell links to that other lanes build**, all in `shell/paths.ts` so one line moves them: feeds `/`, `/local`, `/all`, `/popular`, `/moderating` (C1), `/communities` and `/resolve` (DISC), `/rules`, `/terms`, `/privacy`, `/about` (ADM, a guess), `/submit` (COMPOSER), `/post/<id>` and `/post/<id>/comments/<commentId>` (B1, D), `/u/<handle>`, `/c/<handle>`. "Create post" shows only when signed in. Subscribed shows only when signed in; Moderating only when `ShellData.moderating > 0`. The sidebar's community filter shows only when a list is not empty.
21. **Left out on purpose:** the notifications slot (E2), a search box (no lane builds search in the MVP), save, crosspost, report, and the Controversial sort.
22. **The gallery's own headings are not translated** (developer-facing); every component label in it is.
23. **Mux's `Table` and `Tabs` appear nowhere,** and `themes.css`, `@muxui/react/markdown` and `@muxui/react/text-editor` are not imported.

## 5. Requests to root

1. **Playwright:** add `PEBLISH_UI_KIT: '1'` to `webServer.env` in `e2e/playwright.config.ts`, so a bare `pnpm e2e` starts a server with the gallery on (CI's job env already does; the gallery specs skip with a reason when `/kit` is 404, so a missing variable is not silent but is not a failure either).
2. **B1's stand-ins:** replace `PostVote` and `Html` in `packages/web/src/routes/post/-ui/` with `VoteControl` and `Prose` (props in section 8; labels come from `useVoteLabels()` in `shell/labels.ts`, locale from `useTranslate()`).
3. **CI:** relabel the report-only bundle step; the budget is enforced by `pnpm e2e` now.
4. **Lane A's pages:** swapping their native inputs for `TextField`, `Select` and `Checkbox` from the facade is a request to root, per lane A's note; the light facade fields cost about 3 to 5 kB gzip each on those routes, so the budget allows it.
5. **Route list:** each lane that adds a page asks root to add it to `e2e/payload/routes.ts` (C1: `/` and `/all`; B1: a post page; COMPOSER: `/submit` with `composer: true`).
6. **Lockfile:** `pnpm install` ran once for `@react-aria/optimize-locales-plugin` (commit 1866139, lockfile on its own); root regenerates at integration.
7. `vite.config.ts` carries the plugin, the groups and the manifest writer only; no other part changed.

## 6. Requests to other lanes (through root)

- **C1:** take over `shell/data.ts` (`loadShellData()` is a plain server-side function, see decision 1; return the viewer's subscribed communities split into `local` and `remote`, or the local communities when signed out) and replace `routes/index.tsx`. Render `PostCard` with `usePostCardLabels()`, `DensityControl` with `useDensityLabels()` and `usePrefs()`; call `router.invalidate()` after a subscription change. Do not put Mux `Tabs`, `Table` or `GridList` on rows or the toolbar. For the sort control, `.pb-segmented` (in `density/density-control.css`) is a ready segmented look for plain pressed buttons or links.
- **D:** `CommentThread` takes the flat `CommentView[]` in display order; `continueHref` is `commentPath(postId, commentId)` from `shell/paths.ts`; `ReplyBar` takes `action` and `fields` for the no-JavaScript post and `onSubmit` once hydrated. Pass `docked` as true on the post page.
- **COMPOSER:** take over `shell/create-post.tsx` (one component, a link today). Build the sheet on `@peblish/ui/components/dialog` (`panelClassName`, `backdropClassName`, `contentClassName`). The Dialog costs about 48 kB gzip over the base, so the composer route's budget is the 170 kB total plus the lazy editor chunk (`vendor-editor`); add `/submit` to `e2e/payload/routes.ts` with `composer: true`. If the editor's packages are not in the `vendor-editor` regex in `vite.config.ts`, the check names the chunk that holds them.
- **FED-A, REM, etc.:** none.

## 7. Dependencies added

| Package                                                     | Version | Licence    | Why                                                                                                                          |
| ----------------------------------------------------------- | ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@react-aria/optimize-locales-plugin` (dev, `packages/web`) | 2.1.0   | Apache-2.0 | drops React Aria's translated strings for every locale but en-US and de-DE (about 25 kB gzip); pulls `unplugin` 2.3.11 (MIT) |

## 8. For later lanes: the components, their props and their cost

All components are in `packages/ui/src/components/` (import `@peblish/ui/components/<name>`, no extension). Labels are props, built from the `ui` catalogue by the hooks in `packages/web/src/shell/labels.ts` (`useVoteLabels`, `usePostCardLabels`, `useCommentThreadLabels`, `useReplyBarLabels`, `useDensityLabels`); `translatePlural(locale, area, base, count)` in `i18n/translate.ts` picks `<base>.one` and `<base>.other`.

**VoteControl** (`vote-control`)

```ts
{ score: number;                       // as the server counted it, including the viewer's own vote
  myVote: -1 | 0 | 1;
  onVote?: (value: -1 | 0 | 1) => void | Promise<void>;  // the vote now held; 0 takes it back; a rejection reverts
  disabled?: boolean;
  orientation?: 'vertical' | 'horizontal';
  labels: { group: string; up: string; down: string };
  locale: string; className?: string }
```

**Prose** (`prose`): `{ html: string; className?: string }`. `html` must be what `createMarkdownRenderer()` returned; a click on `span.spoiler` reveals it. Styles in `prose.css` (linked by `web/src/styles.css`).

**PostCard** (`post-card`): `{ post: PostView; density: 'card' | 'classic' | 'compact'; hrefs: { post; community; author }; labels: PostCardLabels; locale: string; onVote?; voteDisabled?; onShare?; headingLevel?: 2 | 3 | 4; now?: Date }`. `onShare` shows the share action. A sensitive post (`sensitive` or `nsfl`) starts hidden. The server decides what a signed-out viewer receives.

**CommentThread** (`comment-thread`): `{ comments: CommentView[]; postAuthorId: string; continueHref(comment); authorHref(comment); labels; locale; onVote?(comment, value); voteDisabled?; onReply?(comment); onShare?(comment); maxDepth?: 6; lowScoreThreshold?: -5; now? }`.

**ReplyBar** (`reply-bar`): `{ target: { handle; excerpt } | null; labels; onSubmit?(body); action?; fields?: Record<string, string>; onPostInstead?; onCancel?; pending?; error?; docked?: true }`. Ctrl or Command with Enter submits.

**DensityControl** (`@peblish/ui/density/density-control`): `{ value: Density; onChange(density); labels: { group; card; classic; compact } }`. `usePrefs()` (`shell/prefs.tsx`) gives `{ prefs, setPrefs({ density?, scheme? }) }`, which applies at once and stores the cookie.

**Facade** (measured gzip cost over a Button-only page of 72.8 kB with React DOM):

| Module                        | Props                                                                                                                                                                                                                                                              | Cost                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `link`                        | Mux `Link`: `href`, `current`, `target`, `rel`, `onActivate`, children                                                                                                                                                                                             | +13.6 kB (React Aria base) |
| `text-field`                  | `label`, `hideLabel`, `description`, `errorMessage` (shown when `invalid`), `value`, `defaultValue`, `onChange(text)`, `name`, `type`, `placeholder`, `autoComplete`, `inputMode`, `maxLength`, `required`, `invalid`, `disabled`, `readOnly`, `size`, `autoFocus` | +3.6                       |
| `text-area` (`TextAreaField`) | the same minus `type`, plus `rows`                                                                                                                                                                                                                                 | +3.5                       |
| `select`                      | `label`, `description`, `errorMessage`, `items` (strings or `{ id, label, disabled }`), `value`, `defaultValue`, `onChange(id)`, `name`, `placeholder`, `required`, `invalid`, `disabled`, `size`                                                                  | +1.1                       |
| `checkbox`                    | children as the label, `description`, `errorMessage`, `checked`, `defaultChecked`, `onChange(checked)`, `name`, `value`, `required`, `invalid`, `disabled`, `size`                                                                                                 | +4.5                       |
| `toolbar`                     | Mux `Toolbar`: `aria-label`, `orientation`, children                                                                                                                                                                                                               | +2.3                       |
| `toggle-button-group`         | `ToggleButtonGroup` (`aria-label`, `selectionMode`, `selectedIds`, `defaultSelectedIds`, `onSelectionChange(ids)`, `disallowEmptySelection`, `size`) and `ToggleButton` (`id`)                                                                                     | +38.5                      |
| `tooltip`                     | `content`, `trigger`, `delay`, `placement`                                                                                                                                                                                                                         | +22.9                      |
| `dialog`                      | `title` or `aria-label`, `description`, `actions`, `open`, `onOpenChange`, `trigger`, `dismissable`, the class props, children                                                                                                                                     | +47.9                      |
| `toast`                       | `ToastProvider`, `useToast().add(message, { title, variant, duration })`                                                                                                                                                                                           | +50.3                      |
| `menu`                        | `Menu.Root`, `.Trigger`, `.Popup`, `.List`, `.Item`                                                                                                                                                                                                                | +57.2                      |
| `button`                      | unchanged (`Button`: `variant`, `size`, `pending`, `onActivate`, `type`)                                                                                                                                                                                           | the base                   |

The costs overlap (they share React Aria and motion code), so the sum is not additive: the whole kit is 166.3 kB. Mux's own `TextField` (+37.2), `Select` (+59.7), `Checkbox` (+13.6) and `RadioGroup` (+47.6) are not offered; a lane that needs one should ask root with the budget in mind.

## 9. Left open and risks

- **The sign-in page is 126.4 kB of React and Mux JS for a page that uses only `Button`.** A scratch build of `MuxProvider` and `Button` with the same vendor groups is 73.7 kB with React DOM (the Mux part 14.5 kB), so the groups are not the cause. In the app build the shared `vendor-mux` chunk is 216.6 kB raw (63.5 kB gzip) and the module inventory lists `react-aria` at 364 kB of source, `react-aria-components` 91.6 kB and `react-stately` 45.1 kB, with Button the only Mux component in it: React Aria is not tree-shaken the way it is in the scratch build. The budget holds with 43.6 kB to spare, so I stopped there. Finding what keeps it whole (the TanStack Start client build marks entries as having side effects; a barrel import is the other suspect) would give back up to about 49 kB on every route that renders a Mux component.
- **The kit has 3.7 kB of room**, and it will fail the check first when a facade module is added to it. That is the intended alarm.
- `useClientLinks` takes every same-origin `<a href>` click that has no modifier, `target` other than `_self` or `download`. A link that must load as a document (a file, a server-rendered page) should carry `download` or `target="_blank"`; sign-out is a form post, not a link.
- No signed-in shell test of my own: the account menu, the admin link and sign-out are exercised by lane A's flows (axe runs on the shell while signed in).
- The `peblish:payload-chunks` manifest sits in `.output/`, so the "no vendor package in an app chunk" check skips against a remote `BASE_URL` (it needs the build output); the per-route numbers do not.
- Hydration of `<time>`: ages can differ by a unit between the server and the browser; `<time>` has `suppressHydrationWarning` and keeps the server's text until its next render.
- The `PEBLISH_UI_KIT` route code ships in the client build (as a lazy route chunk of 25 kB raw) even where the gallery answers 404; the Mux code it needs is in the shared vendor chunks only where its route loads them.
