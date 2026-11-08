# Mux UI on TanStack Start: SSR and hydration gate (G1)

Date: 2026-11-08. Time spent: about 5.5 hours of the one-day box. React Router fallback not built (see "Not done").

**Verdict: GO for TanStack Start.**

The gate holds on TanStack Start 1.169.4 with Mux UI 0.1.0-rc.5. The production build runs in a Node 24 image. Playwright clicks a Table row and opens Dialog, Menu, Tabs and TextEditor (plus Toast, Select, Tooltip and Button) as its first action after hydration, with no mismatch: 40/40 per run, 200/200 over five repeats, also at 6x CPU throttling. A locale detected from `Accept-Language` on the server reaches the components through React Aria's `I18nProvider` and hydrates unchanged. Three conditions come with it. First, "hydrated" must be signalled from inside the route tree, because TanStack Router hydrates route content after the root shell (F2). Second, Mux UI has no locale API, so React Aria is hoisted to reach its provider until Mux exports one (F3). Third, a tap on a Tab or Table row that lands *during* hydration is lost on a slow device. That is a React Aria defect, not TanStack's, and the fallback framework would not remove it (F1). None of these argue for React Router. The bigger product risks this spike surfaced are outside the gate: Markdown without GFM (F5), a Virtualizer with no server rows (F4), and the client payload (F7).

## Versions

| Item | Version | Source |
| --- | --- | --- |
| Node image | `node:24.21.0-bookworm-slim` (same image ID as the cached `node:24-bookworm-slim`), Node v24.21.0 | `start/Dockerfile` |
| pnpm | 10.33.0 via corepack (`packageManager`) | `start/package.json` |
| react / react-dom | 19.2.9 / 19.2.9 | lockfile |
| @tanstack/react-start | 1.169.4 (fix floor 1.168.60) | lockfile |
| @tanstack/start-server-core | 1.169.45 (fix floor 1.169.39) | lockfile |
| @tanstack/react-router | 1.170.46 | lockfile |
| vite | 8.3.6 (`@vitejs/plugin-react` 6.2.1) | lockfile |
| nitro | 3.0.261103-rc, `node-server` preset | lockfile |
| @muxui/react | 0.1.0-rc.5 (what `next` resolves to; `latest` is 0.1.0-rc.1) | `npm view @muxui/react dist-tags` |
| react-aria-components | 1.20.0, one copy (react-aria 3.51.0) | lockfile |
| typescript | 6.0.3, `strict` plus `noUncheckedIndexedAccess` | `start/tsconfig.json` |
| @playwright/test | 1.58.2, Chromium 145.0.7632.6 headless shell | `e2e/package.json` |
| react-router | not used | |

## Criteria

All evidence paths are under `spikes/mux-start/e2e/artifacts/` unless stated. `start/` is the production container, `start-repeat/` the first-click suite run five times, `start-dev/` the Vite dev server (unminified React).

| Criterion | Result | Evidence |
| --- | --- | --- |
| Production build in a Node 24 image | PASS. Multi-stage image: `pnpm install --frozen-lockfile`, `vite build`, `tsc --noEmit`, runtime stage runs `.output/server/index.mjs` (361 MB image). | `start/build.log`, `../start/Dockerfile` |
| (a) No hydration mismatch | PASS. `/gate` and `/gate-plain`, en-US and de-DE: zero console errors or warnings in production and in dev. A negative-control route trips the detector (React #418 in prod, "Hydration failed" in dev), so the check can fail. | `start/console/`, `start/problems/`, `start-dev/console/` |
| (b) First click immediately after hydration | PASS with the page marker (see F2). Fresh page per control, no waits beyond the marker: Table row (`data-muxui-state-selected` set), Dialog opens, Menu opens and an item fires, Tabs switch, TextEditor takes typing, Toast shows, plus Button, Select and Tooltip. Run at CPU x1 and x6, on both variants: 40/40, and 200/200 over five repeats. Probe: 0 missed first clicks in 216. Full suite 52/52 in prod and in dev. | `start/results.json`, `start-repeat/results.json`, `start/facts/first-click-probe-page-marker-*.json`, `start/screens/first-interaction-*` |
| (c) Server-detected locale through the I18n mechanism | PASS with RAC's `I18nProvider` (Mux exposes none, F3). `Accept-Language: de-DE` gives `<html lang="de-DE">`, NumberField `1.234,50 €`, DateField `8.11.2026`, German stepper labels (`verringern`, `Nummernfeld`) in the server HTML; identical at hydration and after settling; no mismatch. Same result with the provider around the root Outlet. | `start/facts/server-detected-de-de-on-gate.json`, `start/facts/i18nprovider-around-the-root-outlet-*.json`, `start/html/gate.de-DE.html` |
| (d) SSR content without JavaScript | PASS. curl HTML carries every Mux root hook (`muxui-button`, `muxui-menu__root`, `muxui-tabs`, `muxui-table`, `muxui-select`, `muxui-number-field`, `muxui-date-field`, `muxui-markdown`, `muxui-text-editor`, `muxui-virtualizer`, `muxui-color-mode-toggle`), 10 table rows and 3 tabs. Virtualizer: **0 rows** on the server (a 640px spacer only), 7 rows after hydration (F4). | `start/html/gate.curl.html`, `start/facts/ssr-gate.json`, `start/facts/client-*.json` |
| (e) Theme | PASS. Server `<html data-muxui-theme="standard-harbour" data-muxui-color-scheme="light">` plus a nested `standard-lagoon` dark scope; ColorModeToggle switches to dark and back after hydration and the body background changes. | `start/facts/theme-*.json`, `start/screens/theme-*-light.png`, `start/screens/theme-*-dark.png` |

## Findings

### F1. Collection item presses are lost during hydration (RAC defect, 8239 / 10613 family)

React Aria Components discards the server-rendered DOM of collection items after hydration and renders new nodes. With references taken to the streamed server nodes before any script ran, these were disconnected after hydration: the (first) Tab element, the Table body, and the (first) row and cell. Reused as-is: the tab list, tab panel, table root, the buttons, the NumberField input, the date segments and the Virtualizer root. Same on `/gate` and `/gate-quiet`, at CPU x1 and x6 (`start/facts/node-survival-*.json`).

The most likely consequence, and the one 10613 describes: a tap that reaches a server node while its boundary is still hydrating is replayed onto, or half-delivered to, a node that is then replaced, so `usePress` never completes a press. Measured with the probe (`e2e/diagnostics/first-click-probe.mjs`, clicking right after the *shell* marker, while the route content may still be dehydrated):

- 33 of 288 first clicks lost, all on a Tab or a Table row with no delay after the shell marker: CPU x6 6/6 each, CPU x4 1 to 4 of 6, CPU x1 none. The second click always works, and a 250ms delay removed every miss.
- Menu and Select triggers (plain buttons) are never lost: React replays the event after hydrating the boundary.
- Clicking after the route content has hydrated: 0/216 lost, at x1, x4 and x6, with or without an app re-render after mount.

This is not the "first click after hydration ignored" form of 8239: with RAC 1.20 the post-hydration first click works. The loss is confined to taps made while hydration is still running, which a fast desktop rarely hits and a slow phone can.

Repro for an upstream issue (RAC 1.20.0, react-aria 3.51.0, React 19.2.9, any SSR framework): server-render `<Tabs><TabList><Tab id="a">A</Tab><Tab id="b">B</Tab></TabList>…</Tabs>`; in the browser hold a reference to the server `Tab` element before hydration (`MutationObserver` in an init script), let it hydrate, then check `element.isConnected`: it is `false`. Throttle the CPU 6x and click tab B while its Suspense boundary is still hydrating (here: right after the root shell's effect): selection does not change, and a second click works. The cause looks like `useCollectionDocument` in `react-aria/dist/private/collections/CollectionBuilder.mjs`: the server snapshot is rendered inline, `resetAfterSSR()` empties the fake document, and the client render then re-creates the items through the portal path instead of adopting the server DOM.

Mitigations for Feddit: keep collection components out of the first-tap path on mobile list pages where possible (post rows as plain links and buttons, not `GridList`/`Table` rows), and track the upstream issue. I found no app-level fix within the box: the replacement happens inside RAC, and re-rendering or remounting after hydration only moves the window.

### F2. A root `useEffect` marker fires before the route is interactive (TanStack Router behavior)

TanStack Router always wraps the root `<Outlet />` child in `React.Suspense` (`@tanstack/react-router/dist/esm/Match.js`, the `rootRouteId` branch; visible as `<!--$-->` right after `<body>`). React 19 hydrates that boundary in a later pass than the shell, so a marker set from the root route's `useEffect` appears while the page content is still dehydrated; under CPU x4 to x6 the gate had not committed at all when it fired. The first test run's x6 failures came from this.

Fix applied: the root sets `data-shell-hydrated`; the gate content sets `data-hydrated` from its own effect, and the suite waits for that. For Feddit: any "app is interactive" signal (analytics, e2e waits, `useHydrated()` hooks) must come from inside the route tree, not the root shell.

### F3. Mux UI exposes no locale provider

`@muxui/react` 0.1.0-rc.5 exports no `I18nProvider`, locale prop or re-export, yet NumberField, DateField, ColorSwatch, CommandPalette and popover placement read RAC's locale context; its compatibility profile lists `locale` as not claimed. Under pnpm's strict layout, app code cannot import `react-aria-components` without adding it as a direct dependency (risking a second copy and a separate context) or hoisting it. Applied: `public-hoist-pattern[]=react-aria-components` in `start/.npmrc`, which exposes the single transitive 1.20.0 copy Mux already uses; no direct dependency added. Without it this criterion could only have been recorded as skipped.

Request for Mux UI: export a locale provider (or re-export RAC's) so consumers pin nothing.

RAC issue 7474 did not reproduce in any placement (inside the route, around the root Outlet with a locale, around it without one), in prod or dev. RAC 1.20 memoizes the context value and skips `useDefaultLocale` when `locale` is passed. Without a provider (`/gate-plain`) RAC renders en-US on the server and through hydration, then switches to the browser language: no React error, but a visible format change (`€1,234.50` to `1.234,50 €`).

### F4. Virtualizer renders no rows on the server

Server HTML is a `role="listbox"` with a spacer of `items × itemHeight` (640px) and no options; 7 rows mount after hydration. No mismatch. Feature request for Mux: since `height` and `itemHeight` are known, server-render the first window so the content exists without JavaScript and on first paint.

### F5. Markdown is CommonMark only

`Markdown` lexes with marked `gfm: false`, and even a `del` token is rendered as plain text. Result: the GFM table stays a paragraph of pipes, `~~struck~~` stays literal, the fenced code block renders as `<pre class="muxui-markdown__code-block" data-muxui-language="ts">` without highlighting (server and client). The catalog does not state the GFM exclusion. Lemmy and PieFed content uses tables, strikethrough, spoilers and superscript, so Feddit needs its own renderer or a Mux extension point. A product-fit gap, not a hydration defect.

### F6. TextEditor content is client-only

The server renders the label and toolbar and an empty `muxui-text-editor__content`; the contenteditable mounts after hydration (Tiptap `immediatelyRender: false`), and was already mounted when the page marker fired. A `defaultValue` would therefore not appear in the server HTML. Fine for a comment composer; a no-JS fallback would need a plain textarea.

### F7. Minor observations

- NumberField defaults `step` to 1, so `defaultValue={1234.5}` displays `1.235,00 €`. The gate passes `step={0.01}`.
- ColorModeToggle's children label overlaps its icon in a flex row; `Menu.Trigger` renders with no button chrome. Cosmetic.
- RAC opens a Tooltip on hover only after a `pointermove` has set pointer modality, so the test moves the mouse once before `hover()`. Real pointers always do; not a defect.
- Payload: the gate chunk is 1.27 MB minified (381 kB gzip), the CSS 978 kB (90 kB gzip), and Mux ships about 2.7 MB of TTF fonts (Inter, Playfair Display, Roboto Mono). The Nitro build logs `[plugin unwasm] Failed to load the WebAssembly module` for Shiki's `onig.wasm` and falls back. Worth a look before Feddit's mobile performance budget is set.
- On Docker Desktop for macOS, file events from the bind mount did not reach the dev container; the dev service now polls (`VITE_USE_POLLING=1`).

## Workarounds applied

1. Page hydration marker set from the route content, not the root (F2).
2. `public-hoist-pattern[]=react-aria-components` to import RAC's `I18nProvider` (F3).
3. `step={0.01}` on NumberField (F7).
4. Test-only: one `mouse.move` before the Tooltip hover (F7).
5. `@playwright/test` pinned to 1.58.2 so its browser is already in the local cache (no download from a non-npm CDN).

## Routes and files

- `/gate`: everything inside RAC's `I18nProvider` with the server-detected locale.
- `/gate-plain`: same content without a provider. `?i18n=root-locale` or `?i18n=root-default` adds one around the root Outlet.
- `/gate-quiet`: diagnostic, `/gate` without the gate's own post-mount re-render.
- `/mismatch-probe`: negative control for the hydration detector.
- `start/`: the app, Dockerfile and `compose.yaml` (project `feddit-spike-mux-start`, prod on `127.0.0.1:18110`, dev on `127.0.0.1:18111`).
- `e2e/tests/`: the suite. `e2e/diagnostics/`: the first-click probe, the node-survival check and `evidence.sh`, which regenerates `artifacts/start*`.

## Not done

- React Router framework mode comparison: not built, because no criterion failed after the marker fix. F1 sits in RAC, and 10613 was reported on React Router 7, so a switch would not remove it. F2 would probably go away, since React Router does not wrap routes in a Suspense boundary by default (not verified here).
- The Mux docs host (Astro Starlight) offered no provider pattern to copy: it imports `@muxui/react/styles.css` from its CSS behind an explicit `@layer` order and puts `data-muxui-color-scheme` on `<html>`, which the gate mirrors.
- Not tested: Firefox, WebKit, real devices, RTL locales, client-side navigation between routes.

## Reproduce

From `spikes/mux-start/` (Docker, pnpm 10 and the cached Chromium 145 headless shell on the host):

```sh
pnpm run build:image   # production image feddit-spike-mux-start:local
pnpm run run           # prod container on http://127.0.0.1:18110, waits for healthy
pnpm run test          # Playwright suite against prod, artifacts in e2e/artifacts/start
pnpm run dev           # optional: Vite dev server in the same image on :18111
pnpm run test:dev      # optional: suite against dev, artifacts in e2e/artifacts/start-dev
sh e2e/diagnostics/evidence.sh   # suite, 5x first-click repeat and both probes (about 20 min)
pnpm run stop          # remove prod and dev containers
```

## Review notes (independent static review, 2026-11-08)

- The artifact totals reproduce: 52/52 production, 52/52 dev, 200/200 repeated first-click checks, 0/216 misses after the route marker, 33/288 misses when only the root-shell marker was used.
- "Immediately after hydration, with no waits beyond the marker" is stronger than the timing evidence. After the marker the tests await a `page.evaluate` and then use Playwright locator clicks, which carry their normal actionability waits; marker-to-pointerdown latency was not recorded. Read the result as "first interaction after the route marker, under Playwright's actionability semantics". A follow-up could timestamp the marker and the pointer events and drive the earliest interval without actionability waiting.
- Attributing the lost taps during hydration exclusively to React Aria, and the claim that React Router would not improve it, are unproven because the React Router control page was not built.
- Coverage is one browser fixture (Chromium headless shell 145); no other engines or assistive technology were exercised.
