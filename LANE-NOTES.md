# Lane MD notes

Lane MD of wave 1: Markdown rendering and remote HTML sanitising (plan rows C14 and C13). Branch `mvp-w1-md`, from `mvp-w1` at 790a03c.

## What landed

| Brief item                   | Where                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `renderMarkdown`          | `packages/core/src/markdown/render.ts`. The plugins are `spoiler.ts`, `images.ts` (PieFed sizing, Lemmy emoji images), `emoji.ts`, `mentions.ts` and `highlight.ts`; per-call data travels in `context.ts` |
| 2. `sanitizeRemoteHtml`      | `packages/core/src/markdown/sanitize.ts`, the same sanitiser renderMarkdown ends in                                                                                                                        |
| 3. Contracts                 | `packages/schema/src/markdown.ts`: `RenderOptions`, `SanitizeOptions`, `ImagePolicy`, `EmojiTable`, `CustomEmoji`, `Mention`, `SanitizedHtml`, `RenderedMarkdown` and the caps                             |
| 4. Web wrapper               | `packages/web/src/server/markdown.ts`: `createMarkdownRenderer(site?)` and `siteMarkdown()`                                                                                                                |
| 5a. Equivalence suite        | `equivalence.test.ts` with `__fixtures__/peers.json` (59 lab cases, 22 spike pairs) and `__fixtures__/capture.ts`                                                                                          |
| 5b. XSS corpus               | `xss.test.ts` with `__fixtures__/xss.ts` (101 HTML vectors, 49 Markdown vectors, both paths)                                                                                                               |
| 5c. Spoilers and the toolbar | `spoiler.test.ts`; the insertion format is `insertSpoiler` in `toolbar.ts`                                                                                                                                 |
| 5d. Timing                   | `perf.test.ts`                                                                                                                                                                                             |
| 6. Dialect table             | `packages/core/src/markdown/README.md`, which also lists the allowlist                                                                                                                                     |

Also: `render.test.ts` and `sanitize.test.ts` for the options and peer shapes, and `packages/web/src/server/markdown.test.ts` for the wrapper.

## How it was verified

- `pnpm check` is green on the final tree: 696 tests in 38 files (G0 had 242 in 31), no boundary violations, Prettier clean. The markdown tests are 454 of those. Every commit was also checked on its own (`pnpm check` in a detached scratch worktree at each commit). One of those runs hit a timeout in core's `outbox/worker.test.ts` (root-owned, unrelated) and passed on re-run. That test polls a consumer, and consumers read only below the oldest open transaction on the whole shared cluster, while other lanes were running their tests on it.
- Timing on this machine (Apple silicon), measured after a warm-up: the 40,000-character post renders in a median of about 11 ms (the test allows 50). The sanitiser at 8 times the input takes 7 to 11 times as long on every adversarial shape (the test allows 24). htmlparser2's own Parser takes about 60 times as long on the same shapes.
- The production build bundles everything (markdown-it, the plugins, highlight.js, htmlparser2) into the Nitro SSR output; none of it needs wasm. Checked with a temporary route, not committed: the built server read `remote_media.enabled` from `peblish_md`, applied `PUBLIC_ORIGIN` and returned the rendered JSON.
- The equivalence fixtures were captured from the federation lab's Lemmy 0.19.21 and PieFed 1.8.11 (see below).

## Decisions and deviations from the brief

1. **The sanitiser is my own, on htmlparser2's Tokenizer, not sanitize-html.** The parity matrix names sanitize-html, but sanitize-html sits on htmlparser2's Parser. That Parser's element stack uses `unshift` and `indexOf`, so its time is quadratic in nesting depth: 280,000 characters of `<b>` then `</i>` took about 0.9 s. That breaks the brief's "linear in input size" and would make a cheap denial of service through the inbox. The Tokenizer is linear and tokenises like a browser (raw text elements included). The stack, the implied end tags and the allowlist are about 400 lines in `sanitize.ts`. The same single pass produces the excerpt and the links. One dependency fewer (no postcss).
2. **The equivalence suite uses new lab captures as well as the spike captures.** The spike captures (`spikes/fedify-threadiverse/captures/`, gitignored, read from the primary checkout) hold 22 distinct peer-authored `content` and `source` pairs. All are one plain paragraph, so they exercise no dialect feature. They are in `peers.json` (`spike`) and tested. For the features I started the existing local lab's Lemmy and PieFed containers (no rebuild, no reset; `docker compose up -d lemmy piefed-web` plus `host-ports`). I then created one post per peer as the seeded users and edited its body to each of 59 cases. `content` was read from each post's ActivityPub object. `__fixtures__/capture.ts` reproduces it. Each run made a new post per peer, so the lab databases now hold six test posts on each peer: four titled "markdown capture" and two "md probe", by `lemmyuser` in `!lab` and `pfuser` in `!pflab`. Both peers were up, so where the seeded cross-follows still hold they will have exchanged these posts; the Fedify spike container was not started. I stopped the containers afterwards (`docker compose --profile host stop`, data kept).
3. **Peers differ from each other, so the dialect picks per feature.** It follows Lemmy and lemmy-ui by default: markdown-it, no raw HTML, scheme-only linkify, typographer. Where PieFed and lemmy-ui go further, it follows them: sub and superscript, footnotes, untitled and nested spoilers. Every remaining difference is listed with its reason in `equivalence.test.ts` and in the README table, and the test fails if a listed difference disappears.
4. **Image sizing is PieFed's form.** The lab shows that neither Lemmy 0.19.21 nor PieFed 1.8.11 accepts `![](url =WxH)` or `{width=}`. PieFed accepts `![alt :: width=200px height=100px align-left](url)` (its `enhanced-images` extra), and that is the form implemented. Lemmy (server and lemmy-ui) has no sizing at all; those words simply stay in its alt text. The remote sanitiser keeps `width`, `height` and `align` on images.
5. **Mentions become links** to `/u/<name>@<host>` and `/c/<name>@<host>` on this instance (the bare name for its own host), with `class="u-url mention"` or `"u-url community"`, as lemmy-ui does in the browser. Neither server links them in content, so this is an accepted difference.
6. **Table alignment is an `align` attribute, not an inline style.** The brief allows no inline styles, and the report-only CSP has no `style-src` for them. Lemmy's `style="text-align:..."` is converted to the same attribute, so tables still match.
7. **Code highlighting** uses highlight.js (BSD-3-Clause, pure JavaScript, its 36-language `common` set). It runs only when the fence names a language it knows, and only for blocks up to 20,000 characters, with no auto-detection. Output is `hljs-*` classes, so the UI needs a theme stylesheet. Lemmy's syntect inline styles and PieFed's Pygments classes are dropped, and code compares by its text.
8. **The excerpt** leaves out spoiler bodies (the summary stays), footnotes, Mastodon's `invisible` link parts and images, so previews and notifications never reveal a spoiler.
9. **Images:** `rewriteImageUrl` returns where an inline image loads from, or `null` to show it as a link. A rewritten URL must be absolute http(s) or a path on this origin. Every inline image gets `loading="lazy"`. The custom emoji table and the hooks are typed in core, not in `RenderOptions`, so a render does not validate a large table each time. Validate it with `EmojiTable` where it is loaded.
10. **PieFed's `tg-spoiler`** (its rendering of Reddit's `>!text!<`) becomes `<span class="spoiler">`, which leaks until the UI hides it (request below). Our own Markdown does not support `>!text!<` yet. It is not in the brief, but feddit.com's PieFed archive may contain it; it would be a short inline rule.
11. **The web wrapper** is a factory, `createMarkdownRenderer(site?)`, that a loader creates per request, rather than a store tied to TanStack Start's request context. It keys its memo by the SHA-256 of the input and options. It takes the origin from `PUBLIC_ORIGIN` and throws without one, and reads `remote_media.enabled`. Off-origin images show as links until lane B2 supplies `proxy`, because decision 5 says viewer IPs never reach remote hosts.
12. **Typings:** markdown-it 15 ships its own types. The three older plugins have none, so `plugins.d.ts` declares them. `render.ts` reaches that file with a triple-slash reference, because web's typecheck compiles core's sources through the import and never sees core's include glob. That needed one `oxlint-disable-next-line typescript/triple-slash-reference`, with the reason in a comment.
13. **The XSS test parses outputs with parse5** (a devDependency), which builds the tree the HTML standard builds. Each output must also survive re-sanitising unchanged. Together these show that the tree a browser builds is the one the serialiser meant, mutation XSS included.

## Dependencies added (`pnpm add --filter @peblish/core`, exact versions)

| Package                | Version | Licence      | Why                                         |
| ---------------------- | ------- | ------------ | ------------------------------------------- |
| `markdown-it`          | 15.0.3  | MIT          | the parser (own types)                      |
| `markdown-it-footnote` | 4.0.0   | MIT          | footnotes (the plugin lemmy-ui uses)        |
| `markdown-it-sub`      | 2.0.0   | MIT          | subscript (as lemmy-ui)                     |
| `markdown-it-sup`      | 2.0.0   | MIT          | superscript (as lemmy-ui)                   |
| `htmlparser2`          | 12.0.0  | MIT          | the sanitiser's tokenizer                   |
| `highlight.js`         | 11.12.0 | BSD-3-Clause | code highlighting                           |
| `parse5` (dev)         | 8.0.1   | MIT          | browser-equivalent parsing in `xss.test.ts` |

New transitive packages: `linkify-it`, `mdurl`, `uc.micro`, `punycode.js` and `dom-serializer` (MIT); `entities`, `domhandler`, `domutils` and `domelementtype` (BSD-2-Clause); `argparse` 3.0.4 (PSF-2.0, markdown-it's CLI). No code was copied from Lemmy, lemmy-ui or PieFed: their output was captured, and their behaviour was read only to explain it.

## Requests to root

1. `pnpm-lock.yaml` and `packages/core/package.json` changed through `pnpm add` (run once per dependency set). They are committed together in their own commit, so you can regenerate the lockfile at integration.
2. Nothing else outside the write set is needed.

## For other lanes

- **UI**: style the classes the HTML carries. That means a highlight.js theme for `pre code` and `.hljs-*`; `span.spoiler` hidden until revealed (from PieFed); `span.invisible { display: none }` and `span.ellipsis::after { content: '…' }` (Mastodon); `img.emoji` at text size; `img { max-width: 100% }`; and `details` and `summary` as spoilers. Footnotes are `sup.footnote-ref`, `hr.footnotes-sep` and `section.footnotes`.
- **B1 (posts)** and **D (comments)**: validate body length at the boundary (`markdownMaxLength` is 50,000, Lemmy's post limit; Lemmy allows 10,000 for comments). For federation `content`, call `renderMarkdown(bodyMd, { baseOrigin: publicOrigin(), idPrefix })` directly from core, with no rewrite, so peers get the original image URLs. Pages use the web wrapper. `mentions` feeds the ActivityPub `tag` list, and `excerpt` feeds summaries and notifications. Pass the post or comment id as `idPrefix` so footnote anchors stay apart in a thread.
- **COMPOSER**: the spoiler button is `insertSpoiler(value, selectionStart, selectionEnd, title)` from `@peblish/core/markdown/toolbar`, which is safe in the browser. Pass a localised title; the default is "Spoiler". A preview is a server function calling `createMarkdownRenderer().render(source)`.
- **FED-B (inbound)**: when an object has `source` with `mediaType: 'text/markdown'` (Lemmy and PieFed send one), render `source.content` with `renderMarkdown` and `baseOrigin` set to this instance. Relative links in Lemmy Markdown mean the viewer's instance, as in lemmy-ui. Otherwise use `sanitizeRemoteHtml(content, { baseUrl: object id })`. Mastodon custom emoji arrive as `:shortcode:` text plus `tag` Emoji objects; the sanitiser does not replace them in HTML yet.
- **B2 (media)**: set `SiteMarkdown.proxy` in `siteMarkdown()` (`packages/web/src/server/markdown.ts`) to the proxy URL builder. If uploads are served from another host (R2), let `rewriteImageUrl` treat that host as own media. Until then, images not on this origin render as links.

## Left open

- Reddit inline spoilers (`>!text!<`) and ruby (`{base|ruby}`) in our own Markdown: PieFed renders both, Lemmy only ruby in lemmy-ui.
- Inline Markdown (emphasis) in spoiler titles: lemmy-ui renders it, we show the title as plain text.
- The 40,000-character timing is checked against this machine. On a much slower CI runner the 50 ms bound may need the runner's own figure.
