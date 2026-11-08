# Lane notes: wave 1 groundwork, Mux UI rc.6

Branch `mvp-w1`, worktree `/Users/admin/Projects/feddit-mvp-w1`, from 790a03c. Brief:
`/Users/admin/.agents/plans/feddit/briefs/wave-1/mux-integration.md`.

## What landed

- cac1829 Vendor the Mux UI 0.1.0-rc.6 release candidate: the tarball in `vendor/muxui/`, the
  vendor README rewritten for the current state, `packages/ui` on the `file:` tarball, the
  lockfile, `LocaleProvider` on `MuxProvider`, no direct `react-aria-components` in ui, no
  hoist in `.npmrc`, `themes.css` dropped, the React Aria fixture moved to a resolved path, the
  Dockerfile comments.
- The commit after it: the G0-STATUS line and these notes.

## Verification

Checksum, before copying and again in the worktree:

```text
879b9175ef8be95a73ba58d0ee2edc2dc306dfbf0616b769a5377104ed51f29f  /Users/admin/.agents/plans/feddit/vendor/muxui-react-0.1.0-rc.6.tgz
879b9175ef8be95a73ba58d0ee2edc2dc306dfbf0616b769a5377104ed51f29f  /Users/admin/Projects/muxui-peblish-rc/dist/muxui-react-0.1.0-rc.6.tgz
879b9175ef8be95a73ba58d0ee2edc2dc306dfbf0616b769a5377104ed51f29f  vendor/muxui/muxui-react-0.1.0-rc.6.tgz
```

The lockfile integrity (`sha512-l1PAu5JT...`) equals `openssl dgst -sha512` of the tarball.
Licence: `package.json` `license` is `MIT`, and `LICENSE` is the MIT text.

- One copy of `@muxui/react` (`pnpm why -r`: rc.6, from `@peblish/ui` only) and one copy of
  `react-aria-components`; nothing resolves Mux from the registry.
- `pnpm check`: green, 242 tests in 31 files, no dependency violations (163 modules), Prettier
  clean. The first run failed 18 tests in `packages/core/src/outbox/worker.test.ts` with
  "Matcher did not succeed in time" and one deadlock: lane FIT was restoring the archive in
  `peblish_fit_archive` at that moment, which holds back the cluster-wide horizon the worker
  reads below. The rerun on a quiet cluster passed; nothing in this change touches core.
- `pnpm e2e` on the build (lane root, port 18399): 19 passed, including the hydration marker
  in en-US and de-DE and axe on the shell without `themes.css`.
- A server render of `MuxProvider` with a React Aria `useLocale()` probe gives `de-DE ltr`,
  `ar-EG rtl`, and `en-US ltr` without a locale, so the locale reaches the copy Mux uses.
- Client CSS is 599.86 kB raw, 61.36 kB gzip (the payload note's rc.6 button scenario).
- Docker: `docker build --target build .` passed: `pnpm fetch --frozen-lockfile` read the
  tarball from `vendor/muxui/`, and `pnpm install --offline --frozen-lockfile` was up to date.
  The full `docker build .` and `scripts/image-smoke.sh` also passed against a throwaway
  `peblish_root_image` database (dropped after), web as uid 1000. `BASE_URL=<image> pnpm e2e`:
  15 passed, 4 lifecycle specs skipped.

## The rc.6 MuxProvider contract

From the installed `generated/mux-provider.d.ts`: `MuxProviderProps` is `locale?: string`,
`navigate?: (href: string) => void`, `useHref?: (href: string) => string` and
`children?: ReactNode`. It renders no element: it wraps React Aria's `I18nProvider`, and adds
`RouterProvider` only when `navigate` is given. `LocaleProvider` passes `locale` and
`children` only.

## Decisions and deviations

- `packages/web/src/__fixtures__/imports-rac-resolved.tsx` is outside the listed write set; step
  3 of the brief asks for it. Without the hoist, `react-aria-components` no longer resolves from
  web. The bare import still failed `mux-only-in-ui`, but as an unresolved specifier, which
  `imports-mux.tsx` already covers. The fixture now imports
  `node_modules/.pnpm/node_modules/react-aria-components/dist/exports/index.mjs`. That is
  pnpm's private hoist directory (default `hoist-pattern=*`), with no version in the path, and
  it resolves to the single copy Mux uses. `tests/boundaries.test.ts` is unchanged.
- The Dockerfile already copied `vendor/muxui/` before `pnpm fetch` (round 1, item 9). I kept
  that line rather than widening it to `vendor/`, because only Mux is vendored, and changed
  only the comments.
- No payload budget check, as the brief says (it awaits Andrew).
- `packages/web/vite.config.ts` is unchanged; `exportConditions: ['!unwasm']` stays.

## For the lanes and root at integration

- `LocaleProvider({ locale, children })` in `@peblish/ui/locale` is unchanged; no web file needs
  to change.
- UI lane: wiring `navigate` and `useHref` to the TanStack router is still to do. It belongs
  in ui's `LocaleProvider` (or a sibling provider) so web keeps importing only the facade.
- UI lane: `packages/ui/src/theme/root.tsx` still sets `data-muxui-theme="standard-harbour"`.
  Only `themes.css` had selectors for it, so the attribute is now inert (the default palette
  in `styles.css` uses the same brand colour). `data-muxui-color-scheme` is still read by
  `styles.css`. Drop the theme attribute or leave it for a later preset; nothing breaks either
  way.
- ui can no longer import React Aria directly; use the Mux export. Re-adding
  `react-aria-components` to ui needs root.
- The lane worktrees (az, a, fit, md) still install rc.5 with the hoist. After a rebase onto
  this branch, delete `node_modules` before `pnpm install`: a plain `pnpm install` here kept
  the stale root `node_modules/react-aria-components` symlink from the old hoist.
- Worker tests are sensitive to any long write transaction on the shared cluster (an archive
  restore, a stuck psql). A lane that sees `worker.test.ts` time out should check
  `pg_stat_activity` and rerun before debugging.
- Every lane writes `LANE-NOTES.md` at its root, so this file will conflict by name at
  integration.

## Requests to root

- `renovate.json`: the Node rule's description says "Mux engines >=24.19 <25". rc.6 declares
  `>=24.19.0 <27`, so only the root `engines` field holds Node below 25 now. Update the text,
  or keep the rule as is.
- Optional: the React Aria fixture would quietly become unresolved, and still pass, if
  `.npmrc` ever disabled pnpm's private hoist. A check in `tests/boundaries.test.ts` that the
  resolved fixtures resolve (no `not-to-unresolvable` hit) would catch that.

## Dependencies added

None beyond the tarball. `react-aria-components` was removed from `packages/ui`.
