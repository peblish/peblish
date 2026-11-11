# Payload

The budget check is `e2e/payload/budget.spec.ts`, with the limits in `e2e/payload/budget.ts`: each page's first visit with a cold cache, gzip -9 for text and woff2 as sent, kB of 1000 bytes.

## During the Mux UI restyle (from 2026-11-11)

Script and CSS sizes are report-only: the check still measures and prints them for every page (`payload <route>: js ..., css ..., fonts ...`) and notes an overrun on the test (`payload-over`), but does not fail on them. This covers the React and Mux UI script, the composer's editor chunk and Mux UI's stylesheet. Still enforced: the font budget (270 kB), no full font file, no vendor package outside its named chunk, only the composer loading the editor, no `themes.css` rules, and every page budgeted or excused in `routes.ts`.

The budget is set again when the restyle lands, from the figures the finished pages print.

## Figures before the restyle

Measured on the production build at 832837d plus the groundwork commit (wrappers and Mux-only tokens; no page uses a new component yet).

| Page                                                                                 | React and Mux UI JS          | Mux UI CSS | Fonts    |
| ------------------------------------------------------------------------------------ | ---------------------------- | ---------- | -------- |
| Most pages (feeds, auth, admin, settings, notifications, modlog, reports, directory) | 126.6 kB                     | 60.4 kB    | 105.6 kB |
| `/admin/pages/<slug>/<language>`                                                     | 128.7 kB                     | 60.4 kB    | 105.6 kB |
| `/u/<handle>/edit`                                                                   | 128.4 kB                     | 60.4 kB    | 259.2 kB |
| `/u/<handle>`                                                                        | 126.6 kB                     | 60.4 kB    | 143.3 kB |
| `/c/<handle>`                                                                        | 129.2 kB                     | 60.4 kB    | 105.6 kB |
| `/c/new`, `/c/<handle>/edit`                                                         | 130.7 kB                     | 60.4 kB    | 259.2 kB |
| `/post/<id>`, its comment permalink                                                  | 129.8 kB                     | 60.4 kB    | 105.6 kB |
| `/submit` signed in                                                                  | 130.7 kB (editor chunk 0 kB) | 60.4 kB    | 259.2 kB |
| `/kit` (its own ceiling, 180 kB)                                                     | 170.5 kB                     | 60.4 kB    | 259.2 kB |
| Composer sheet, when opened                                                          | +44.2 kB JS, +1.5 kB CSS     |            |          |

Limits that were enforced until now: script 170 kB (the kit 180 kB), CSS 65 kB, fonts 270 kB, editor 200 kB. Fonts are close to their limit on pages with italic and code text (259.2 kB of 270 kB).
