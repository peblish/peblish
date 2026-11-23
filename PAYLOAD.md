# Payload

The budget check is `e2e/payload/budget.spec.ts` (with `e2e/composer/payload.spec.ts` for `/submit` signed in): each page's first visit with a cold cache, gzip -9 for text and woff2 as sent, kB of 1000 bytes.

## The budgets

- **Script, per page, enforced.** React, React DOM and Mux UI (the `vendor-react` and `vendor-mux` chunks; the app's own chunks are not counted). Each page has its own budget, stored as `js: { budget, measured, on }` on its entry in `e2e/payload/routes.ts`; `/submit` signed in has `signedInJs` on the `/submit` entry. A page over its budget fails its test.
- **Fonts, enforced:** 270 kB, no full font file, and no Latin-extended or other slice in German either.
- **Mux UI CSS, report-only:** 65 kB, printed and noted on the test (`payload-over`) when over, never a failure.
- **Editor:** the sheet's lazy script, when it opens, stays inside 200 kB (enforced); the editor chunk on the signed-out `/submit` is report-only against the same figure; no other page loads it.
- Also enforced: no vendor package outside its named chunk, no `themes.css` rules, and every page budgeted or excused in `routes.ts`.
- **Under a brand pack** (`site.brand`, `packages/ui/src/brand`): `e2e/payload/brand.serial.spec.ts` sets the feddit pack and runs the same checks on `/kit` (the most fonts) and `/`, which also need the pack's sheet to hold only token overrides on `:root` and its faces, and its wordmark face to load. The pack adds the same files to every page: its sheet, its icons and, in the desktop header only, the wordmark face (Quicksand Bold cut to the letters of "feddit", 7.2 kB as a woff file): `/kit`'s 259.2 kB of fonts and the face make 266.4 kB, inside 270. The figures print as `payload <page> (brand pack): ..., pack css ...`.

Until 2026-11-12 the script budget was one figure for every page, 170 kB (the `/kit` gallery 180 kB), set before the Mux UI shell; the shell and Mux UI took every page to 181 to 230 kB, so the check could only report, and each page now has its own budget instead.

## How the script budgets were set

On 2026-11-12, `main` at ccfc0db (Mux UI rc.7): a fresh `pnpm build`, then the payload specs three times, each on a freshly created lane database. The three runs printed the same figures to 0.1 kB on every page, and the same size for every chunk, so nothing varied. Each budget is the measured figure plus 5%, rounded up to 0.1 kB, and stored as that number: nothing is computed when the check runs.

On 2026-11-23 the site banner, the width setting and the community finder raised 35 budgets (34 pages and `/submit` signed in). The figures come from two production builds of the same commit, CI's and a local one, which printed the same figures to 0.1 kB on every page; each budget is again the figure plus 5%, rounded up to 0.1 kB. What grew:

- Every page, 8.4 to 9.8 kB: Mux UI's Banner and its icons, since the server draws the site banner on every page whenever one is published, with or without scripts; and Mux UI's Skeleton in the finder's loading placeholder, which comes with the page so that a press on Find shows it at once.
- `/admin/settings`, 75.4 kB: the banner and width form, with the colour field (Mux UI's ColorField and React Aria's colour code, about 30 kB) and the switch that no other product page uses, and its radio groups and select.
- `/submit` signed in, 23.0 kB: Create post's community field (Mux UI's ComboBox), which takes the radio list's place as the page hydrates.

About 3 to 4 kB of each page's growth is the vendor split making more Mux files (`/` loads 31, up from 22), each compressed on its own. That, and loading the colour field only once Custom is chosen, are left for a follow-up.

## When a page fails

The failure names the page, its size, its budget and when the budget was measured, and the log lists the page's React and Mux chunks (each named after the routes that share it). Find what grew: compare with the same lines on `main`. If the growth is intended, re-measure and raise that page's `budget` (with its `measured` and `on`) in `routes.ts` in the same pull request, saying why in its description.

## Re-measuring

On your lane (`<lane>` as in `scripts/lane.sh`), three times, keeping the largest figure of each page:

```sh
pnpm build
docker compose -f compose.yaml exec -T postgres dropdb -U peblish --force --if-exists peblish_<lane>
lane_env=$(sh scripts/lane.sh <lane>) && eval "$lane_env"
pnpm e2e e2e/payload e2e/composer/payload.spec.ts 2>&1 | grep '^payload '
```

Each page prints `payload <page>: js <measured> of <budget>, css ..., fonts ...`; `/submit` signed in prints `payload /submit (signed in): js ...`. The new budget is the largest measured figure times 1.05, rounded up to 0.1 kB. A page added to `routes.ts` is measured the same way; `js` is required, so it cannot be added without one.

## Script, measured and budget (kB)

Signed in means the admin session the check carries (two-factor on). Each row is dated by its `on` in `routes.ts`. `/you` carries the budget of `/settings/account` until a build measures it; it, `/u/<handle>/edit`, `/notifications` and `/admin/registration` have no figure from 2026-11-23, when their fixture timed out waiting for its mailed link. On 2026-11-23 fonts were 105.6 kB, 143.3 kB on `/settings/account` and `/u/<handle>`, 259.2 kB on `/kit`, and 112.7 kB on `/` under the feddit pack. Opening the composer sheet adds 67.7 kB of script in 22 files and 1.2 kB of CSS (of 200 kB); on 2026-11-12 it added 53.6 kB in 14 files and 1.1 kB.

Mux UI CSS was 62.6 kB on every page on 2026-11-12 and 65.7 kB on `main` before 2026-11-23, already over its report-only 65 kB; the banner, finder and community field styles take it to 66.0 kB.

| Page                                       | Signed in | Measured | Budget | On         |
| ------------------------------------------ | --------- | -------- | ------ | ---------- |
| `/`                                        | no        | 199.8    | 209.8  | 2026-11-23 |
| `/all`                                     | no        | 199.8    | 209.8  | 2026-11-23 |
| `/local`                                   | no        | 199.8    | 209.8  | 2026-11-23 |
| `/popular`                                 | no        | 199.8    | 209.8  | 2026-11-23 |
| `/moderating`                              | no        | 199.8    | 209.8  | 2026-11-23 |
| `/communities`                             | no        | 230.3    | 241.9  | 2026-11-12 |
| `/resolve`                                 | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/sign-in`                            | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/sign-up`                            | no        | 199.4    | 209.4  | 2026-11-23 |
| `/auth/sign-up?invite=<code>`              | no        | 199.4    | 209.4  | 2026-11-23 |
| `/auth/reset`                              | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/reset?token=<mailed>`               | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/two-factor`                         | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/verify?token=<mailed>`              | no        | 198.5    | 208.5  | 2026-11-23 |
| `/auth/verify`                             | yes       | 198.5    | 208.5  | 2026-11-23 |
| `/invite/<code>`                           | no        | 198.5    | 208.5  | 2026-11-23 |
| `/settings/account`                        | yes       | 198.5    | 208.5  | 2026-11-23 |
| `/settings/security`                       | yes       | 199.4    | 209.4  | 2026-11-23 |
| `/settings/blocks`                         | yes       | 216.6    | 227.5  | 2026-11-23 |
| `/u/<handle>`                              | no        | 201.0    | 211.1  | 2026-11-23 |
| `/u/<handle>/edit`                         | yes       | 186.4    | 195.8  | 2026-11-12 |
| `/you`                                     | yes       | 185.3    | 194.6  | 2026-11-12 |
| `/notifications`                           | yes       | 182.1    | 191.3  | 2026-11-12 |
| `/admin/registration`                      | yes       | 204.0    | 214.2  | 2026-11-12 |
| `/c/<handle>`                              | no        | 201.2    | 211.3  | 2026-11-23 |
| `/c/new`                                   | yes       | 201.4    | 211.5  | 2026-11-23 |
| `/c/<handle>/edit`                         | yes       | 201.4    | 211.5  | 2026-11-23 |
| `/admin/bans`                              | yes       | 218.0    | 228.9  | 2026-11-23 |
| `/admin/peers`                             | yes       | 218.0    | 228.9  | 2026-11-23 |
| `/modlog`                                  | no        | 190.8    | 200.4  | 2026-11-22 |
| `/admin/reports`                           | yes       | 217.1    | 228.0  | 2026-11-23 |
| `/admin/settings`                          | yes       | 266.8    | 280.2  | 2026-11-23 |
| `/admin/pages`                             | yes       | 217.1    | 228.0  | 2026-11-23 |
| `/admin/pages/<slug>/<language>`           | yes       | 207.8    | 218.2  | 2026-11-23 |
| `/about`                                   | no        | 190.8    | 200.4  | 2026-11-22 |
| `/admin/media`                             | yes       | 225.5    | 236.8  | 2026-11-23 |
| `/post/<id>`                               | no        | 201.4    | 211.5  | 2026-11-23 |
| `/post/<id>/comments/<commentId>`          | no        | 200.4    | 210.5  | 2026-11-23 |
| `/submit` (signed out, lands on sign-in)   | no        | 198.5    | 208.5  | 2026-11-23 |
| `/submit` (`e2e/composer/payload.spec.ts`) | yes       | 250.0    | 262.5  | 2026-11-23 |
| `/report?kind=post&id=<id>`                | yes       | 229.6    | 241.1  | 2026-11-23 |
| `/report/sent?n=<number>`                  | yes       | 190.8    | 200.4  | 2026-11-22 |
| `/kit`                                     | no        | 214.4    | 225.2  | 2026-11-23 |
