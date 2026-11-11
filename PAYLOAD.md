# Payload

The budget check is `e2e/payload/budget.spec.ts` (with `e2e/composer/payload.spec.ts` for `/submit` signed in): each page's first visit with a cold cache, gzip -9 for text and woff2 as sent, kB of 1000 bytes.

## The budgets

- **Script, per page, enforced.** React, React DOM and Mux UI (the `vendor-react` and `vendor-mux` chunks; the app's own chunks are not counted). Each page has its own budget, stored as `js: { budget, measured, on }` on its entry in `e2e/payload/routes.ts`; `/submit` signed in has `signedInJs` on the `/submit` entry. A page over its budget fails its test.
- **Fonts, enforced:** 270 kB, no full font file, and no Latin-extended or other slice in German either.
- **Mux UI CSS, report-only:** 65 kB, printed and noted on the test (`payload-over`) when over, never a failure.
- **Editor:** the sheet's lazy script, when it opens, stays inside 200 kB (enforced); the editor chunk on the signed-out `/submit` is report-only against the same figure; no other page loads it.
- Also enforced: no vendor package outside its named chunk, no `themes.css` rules, and every page budgeted or excused in `routes.ts`.

Until 2026-11-12 the script budget was one figure for every page, 170 kB (the `/kit` gallery 180 kB), set before the Mux UI shell; the shell and Mux UI took every page to 181 to 230 kB, so the check could only report, and each page now has its own budget instead.

## How the script budgets were set

On 2026-11-12, `main` at ccfc0db (Mux UI rc.7): a fresh `pnpm build`, then the payload specs three times, each on a freshly created lane database. The three runs printed the same figures to 0.1 kB on every page, and the same size for every chunk, so nothing varied. Each budget is the measured figure plus 5%, rounded up to 0.1 kB, and stored as that number: nothing is computed when the check runs.

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

## Script, measured and budget (kB, 2026-11-12)

Signed in means the admin session the check carries (two-factor on). CSS was 62.6 kB on every page; fonts 105.6 kB, 143.3 kB on `/settings/account` and both `/u/<handle>` pages, 259.2 kB on `/kit`. Opening the composer sheet adds 53.6 kB of script in 14 files and 1.1 kB of CSS (of 200 kB).

| Page                                       | Signed in | Measured | Budget |
| ------------------------------------------ | --------- | -------- | ------ |
| `/`                                        | no        | 183.4    | 192.6  |
| `/all`                                     | no        | 183.4    | 192.6  |
| `/local`                                   | no        | 183.4    | 192.6  |
| `/popular`                                 | no        | 183.4    | 192.6  |
| `/moderating`                              | no        | 183.4    | 192.6  |
| `/communities`                             | no        | 230.3    | 241.9  |
| `/resolve`                                 | no        | 185.3    | 194.6  |
| `/auth/sign-in`                            | no        | 185.3    | 194.6  |
| `/auth/sign-up`                            | no        | 187.1    | 196.5  |
| `/auth/sign-up?invite=<code>`              | no        | 187.1    | 196.5  |
| `/auth/reset`                              | no        | 185.3    | 194.6  |
| `/auth/reset?token=<mailed>`               | no        | 185.3    | 194.6  |
| `/auth/two-factor`                         | no        | 185.3    | 194.6  |
| `/auth/verify?token=<mailed>`              | no        | 185.3    | 194.6  |
| `/auth/verify`                             | yes       | 185.3    | 194.6  |
| `/invite/<code>`                           | no        | 185.3    | 194.6  |
| `/settings/account`                        | yes       | 185.3    | 194.6  |
| `/settings/security`                       | yes       | 186.1    | 195.5  |
| `/settings/blocks`                         | yes       | 202.4    | 212.6  |
| `/u/<handle>`                              | no        | 188.7    | 198.2  |
| `/u/<handle>/edit`                         | yes       | 186.4    | 195.8  |
| `/notifications`                           | yes       | 182.1    | 191.3  |
| `/admin/registration`                      | yes       | 204.0    | 214.2  |
| `/c/<handle>`                              | no        | 189.0    | 198.5  |
| `/c/new`                                   | yes       | 188.0    | 197.4  |
| `/c/<handle>/edit`                         | yes       | 188.0    | 197.4  |
| `/admin/bans`                              | yes       | 204.9    | 215.2  |
| `/admin/peers`                             | yes       | 204.9    | 215.2  |
| `/modlog`                                  | no        | 181.4    | 190.5  |
| `/admin/reports`                           | yes       | 204.0    | 214.2  |
| `/admin/settings`                          | yes       | 186.7    | 196.1  |
| `/admin/pages`                             | yes       | 203.0    | 213.2  |
| `/admin/pages/<slug>/<language>`           | yes       | 194.0    | 203.7  |
| `/about`                                   | no        | 181.4    | 190.5  |
| `/admin/media`                             | yes       | 212.0    | 222.6  |
| `/post/<id>`                               | no        | 189.2    | 198.7  |
| `/post/<id>/comments/<commentId>`          | no        | 188.2    | 197.7  |
| `/submit` (signed out, lands on sign-in)   | no        | 185.3    | 194.6  |
| `/submit` (`e2e/composer/payload.spec.ts`) | yes       | 222.2    | 233.4  |
| `/report?kind=post&id=<id>`                | yes       | 215.8    | 226.6  |
| `/report/sent?n=<number>`                  | yes       | 181.4    | 190.5  |
| `/kit`                                     | no        | 200.6    | 210.7  |
