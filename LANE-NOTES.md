# Lane D notes (wave 2)

Comments: plan rows D09 (threaded comments) and D08 (comment sorts). Branch `mvp-w2-d`, from `mvp-w2` at e886daf, port 18312, database `peblish_d`. Success criterion from the plan: the 51st level refused with the exact reason, deep threads render in budget.

## 1. What landed

| Deliverable                                                                                                          | Where                                                                                          | Proof                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policies `comment.create`, `comment.update`, `comment.delete`                                                        | `c/authz/actions/comments.ts`, refusals `s/refusals/comments.ts`                               | `c/comments/policies.test.ts`: 12 principals against 12 post and parent states, plus the author actions in 7 states, as precheck and as recheck (58 tests)                                                                                                              |
| `auth.email_unverified` first, before any community lock                                                             | `emailUnverified` in `comments.ts`                                                             | `c/comments/mutations.test.ts`: a second connection can still take the community row `NOWAIT` after the refusal, and cannot after a verified person's policy (55P03)                                                                                                    |
| 51st level refused with `comment.depth_exceeded`, for local and remote replies                                       | policy; `insertComment` repeats it as a refusal; the `comments_depth` CHECK stays the backstop | `mutations.test.ts` (50 levels created, the 51st refused, nothing written); `remote.test.ts` (remote principal); policy table (`level 49` allowed, `level 50` refused)                                                                                                  |
| Locked posts refuse everyone, moderators and admins too                                                              | `commentingDenial` (AZ) is final                                                               | policy table; `mutations.test.ts`: a lock between authorize and write refuses the stale grant and writes nothing; so do a ban and a delete of the parent                                                                                                                |
| `createComment`, `updateComment`, `deleteComment`, counts and events in the same transaction                         | `c/comments/{create,edit,delete,insert}.ts`                                                    | `mutations.test.ts`: row, counts and `comment.created` share a transaction (xmin of the row equals the outbox `tx_id`); twenty concurrent replies at different depths count exactly with no deadlock; a no-op edit emits nothing; a delete is soft and changes no count |
| Services for web, with the author's own upvote                                                                       | `c/comments/actions.ts`: `createCommentAs`, `updateCommentAs`, `deleteCommentAs`               | `mutations.test.ts` (the new comment has score 1)                                                                                                                                                                                                                       |
| Remote counterparts for FED-B                                                                                        | `c/comments/remote.ts`: `resolveReplyTarget`, `storeRemoteComment`, `updateRemoteComment`      | `remote.test.ts`: sanitised HTML, Markdown source rendered, receive time, a redelivered Create changes nothing, `distinguished` not read, a Note replying to something else refused, the 51st level refused, a peer's Delete by the author                              |
| Sort seam: Hot, Top, New, Old over a validated `sort` parameter                                                      | `c/comments/sort.ts`: `parseSort`, `compareSiblings`, `inDisplayOrder`                         | `sort.test.ts` (each sort's sibling order, Lemmy's hot rank, depth-first order); `read.test.ts` (the same through the database)                                                                                                                                         |
| Thread read model: flat `CommentView[]` with `depth` and `parentId`, for a post or for the subtree under one comment | `c/comments/read.ts`: `readThread`; limits in `c/comments/limits.ts`                           | `read.test.ts`: display order, depth cap, permalink subtree, page cap, tombstones, removal reason only for moderators, own votes, badges, remote handle                                                                                                                 |
| Thread under the post, docked reply bar, sort control, votes                                                         | `w/routes/post/$id/comments/-ui/thread-section.tsx`, mounted in B1's post page                 | `e2e/comments/comments.spec.ts`                                                                                                                                                                                                                                         |
| "Continue this thread" at `/post/<id>/comments/<commentId>`; the author's edit and delete on it                      | `w/routes/post/$id/comments/$commentId.tsx`, `-ui/permalink-page.tsx`                          | `comments.spec.ts`: continue link, parent and all-comments links, edit and delete, axe                                                                                                                                                                                  |
| Reply, edit and delete forms: a plain POST to `/post/<id>/comments`, JSON once hydrated                              | `w/routes/post/$id/comments/index.tsx`, `-form.ts`                                             | `comments.spec.ts`: reply hydrated and with JavaScript off (post page and permalink page), refusals with exact reasons, cross-site 403, signed-out `?commentError=auth.required`                                                                                        |
| Render budget                                                                                                        | `c/comments/budget.test.ts`; `comments.spec.ts` ("a 500-comment thread that reaches level 50") | see section 3                                                                                                                                                                                                                                                           |
| Strings in en-US and de-DE                                                                                           | `w/i18n/comments.json`                                                                         | German spec with axe                                                                                                                                                                                                                                                    |

(`c/` is `packages/core/src/`, `s/` is `packages/schema/src/`, `w/` is `packages/web/src/`.) Test seeds: `c/testing/seed-d.ts` (`seedCommentWorld`, `seedReply`, `seedChain`, `seedBigThread`, and a CLI, `node packages/core/src/testing/seed-d.ts e2e`).

## 2. Commits

| Commit  | Change                                                                     |
| ------- | -------------------------------------------------------------------------- |
| 2684b57 | Add the comment policies, mutations and remote counterparts                |
| 2f6bafe | Add the thread read model and the sort seam                                |
| d95d159 | Count every comment below a comment in child_count (decision 1)            |
| 7408e11 | Refuse a community commenting, and move the thread limits to a pure module |
| 945cbc4 | Add the thread under the post, the permalink page and the comment forms    |
| 9b3a96d | Add the comments e2e and its seed                                          |
| (this)  | LANE-NOTES.md                                                              |

Nothing waits on an early merge. FED-B can use 2684b57 (mutations and `resolveReplyTarget`) as soon as it likes; it needs the refusal from 7408e11 for a Group principal.

## 3. Verification

On the final tree, lane `d`:

- `pnpm install --frozen-lockfile`: up to date, no lockfile change. No dependency added.
- `pnpm check`: green, 106 test files passed and 1 skipped, 1,585 tests passed and 2 skipped (FIT's opt-in tests); wave 2's integrated tree had 1,481. Boundaries, oxlint and Prettier clean. One earlier run hit the known `worker.test.ts` timeout ("wakes on commit and stops on abort") while other lanes were running tests on the shared cluster; it passed twice alone and on the rerun.
- `PEBLISH_UI_KIT=1 pnpm e2e` on port 18312: 117 passed, 1 skipped (the `/kit` 404 test). Mine are 18 in `e2e/comments`. The payload budget holds: `/post/<id>` is 127.4 kB of 170 kB script (126.4 before the thread), 60.4 of 65 CSS.
- `git status` shows no change under `packages/core/drizzle/`: no table, no migration (section 5).
- The mutation-registry test passes: all five comment mutations set `recheck: true`.

Render budget ("a 500-comment thread that reaches level 50 renders server-side in under 200 ms"), seeded by `seedBigThread` (a chain to level 50, the rest under random earlier comments, 500 in all; 136 of them are within the 6 levels the page draws):

| Measure                                                                                                  | Result                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `readThread` plus the Markdown of every comment sent (`budget.test.ts`, best of 3 after a warm-up)       | 7 to 11 ms                                      |
| The whole page, anonymous, warm server, `curl` on the production build (267 kB of HTML for 136 comments) | 22 to 37 ms                                     |
| The same in `comments.spec.ts` (best of 5 through Playwright, asserted under 200 ms)                     | passes, well inside                             |
| A 5,000-comment thread, `readThread` alone (300 comments sent)                                           | 12 to 40 ms (630 to 1,070 ms before decision 1) |

The assertion in both tests is 200 ms. The thread sent never goes past level 6 and never past 300 comments, whatever the thread holds.

### Queries and EXPLAIN (Gate 3 reviews SQL and indexes of comments)

One `readThread` runs these, none per row: the post's community (primary key); the thread rows; the authors with their instance (primary key list); admin badges (primary key list joined to `auth_user`); moderator badges and the viewer's own role (`community_moderators` primary key); the viewer's votes in the post (`votes_voter_comment` joined to `comments`); the texts of the live comments sent (primary key list); and, only for a moderator with removed comments in view, one `readModlog` (newest 200 of the community).

The thread rows, post page (`nlevel(path) <= 6`, `limit 2000`), on a 5,000-comment thread in an 11,000-row table. At this size the planner scans the table; with `enable_seqscan = off` it uses `comments_post_path`:

```
select id, ap_id, author_id, parent_id, path, upvotes, downvotes, published_at, edited_at, deleted_at, removed_at, child_count
from comments where post_id = $1 and nlevel(path) <= 6 order by path limit 2000

 Limit (actual time=18.939..19.138 rows=1866 loops=1)
   ->  Sort (Sort Key: path, quicksort 781kB)
         ->  Bitmap Heap Scan on comments (actual time=11.066..16.283 rows=1866)
               Recheck Cond: (post_id = '...'::uuid)    Filter: (nlevel(path) <= 6)    Rows Removed by Filter: 3135
               ->  Bitmap Index Scan on comments_post_path (actual time=10.950..10.956 rows=5001)
                     Index Cond: (post_id = '...'::uuid)
 Execution Time: 19.439 ms        (seq scan plan, the default here: 7.3 ms)
```

The permalink's subtree (`path <@ root`, depth `nlevel(root) + 5`) uses the GiST `comments_path`:

```
 Limit (actual time=20.916..20.930 rows=140 loops=1)
   ->  Sort (Sort Key: comments.path)
         ->  Bitmap Heap Scan on comments (actual time=18.903..20.801 rows=140)
               Recheck Cond: (path <@ (InitPlan 2).col1)
               Filter: ((post_id = '...') AND (nlevel(path) <= 9))
               ->  Bitmap Index Scan on comments_path (actual time=18.779..18.779 rows=6052)
 Execution Time: 21.093 ms
```

The ancestor update of a new reply, `update comments set child_count = child_count + 1 where post_id = $1 and path @> $parent`, uses the same GiST index for `@>`; it touches at most 49 rows.

`comments_post_path` would serve the first query as an ordered index scan (no sort) on a bigger table. If `NOT NULL` on `nlevel(path)` ever matters, an expression index on `(post_id, nlevel(path), path)` is the next step; nothing needs it at beta scale.

## 4. Decisions and deviations from the brief

1. **Deviation: `comments.child_count` counts every comment below, at any depth, not only direct replies.** The brief says "the parent's `child_count` (direct replies, as FIT's lab-live counts them)"; FIT's note 14 leaves the definition to D. This is Lemmy's definition, it is what UI's `CommentThread` reads as `counts.comments` ("the number of descendants", UI note 4.18, confirmed by root), and it makes the read free: the first version counted descendants per row at read time with the GiST index and took 630 to 1,070 ms for a 5,000-comment thread; reading the column takes 12 to 40 ms. The cost is on write: a new reply updates its parent and every ancestor (at most 49 rows) in one statement. That is safe under the lock order: every writer that touches a comment holds the community row first and the post second (policies take them through `commentState` and `postState`; a ban with `removeData` holds the community row exclusively), so none can reach an ancestor ahead of the transaction that holds those two. The twenty-reply concurrency test shows exact counts and no 40P01. FIT's `lab-live` set has no comment more than one level deep, so its direct counts equal the new ones (checked); only the comment in `fixtures/set.ts` ("Direct replies in the set") is out of date (request 7).
2. **A delete changes no count.** `posts.comment_count` and `child_count` count every comment row, deleted and removed ones included, because the tombstone and the replies under it stay in the thread and the component counts them. The brief's "counters after create and delete" is tested as "unchanged". If root wants Lemmy's other reading (live comments only), the change is a decrement in `deleteComment` and in AZ's `removeContent`, which D does not own.
3. **Locked posts refuse everyone** (brief; the policy table proves moderators, owners and admins are refused too). An author can still edit or delete their own comment under a locked post: a lock stops new comments. An edit needs a live post (Lemmy's rule); a delete needs only the comment to be live.
4. **Depth shown: 6 levels** (UI's `maxDepth` default, `threadDisplayDepth`). A comment on level 6 shows "Continue this thread" and "N more replies" from its `counts.comments`. The permalink page shows 6 levels again from its comment. At most 300 comments are sent (`threadMaxComments`, Lemmy's page size), the first in display order, and `truncated` says there were more. At most 2,000 rows are read, in path order, which always yields whole parents-before-children trees. There is no "load more" for a post with more than 300 comments within 6 levels (request 5, risk 2).
5. **Self-upvote.** `createCommentAs` casts the author's upvote after creating, like `createPostAs` (root's decision for posts), best effort, a second mutation and a second `vote.cast` event. Not in the brief.
6. **`distinguished` is not read from a peer's Note** (an author could mark their own comment), like B1's `locked` and `featuredCommunity`.
7. **The remote Group rule.** `comment.create` refuses a remote Group principal with the new `comment.group_cannot_act` before any lock, as the coordinator's note for the B1 fix asks (`post.group_cannot_act`). The read of the actor's kind is not locked: a kind never changes.
8. **Reply state order.** A locked, deleted or removed post says so to everyone, signed in or not; signing in would not help. Then signed out ("Sign in to comment"), then an unverified email, then the bar. The server still refuses every case on its own.
9. **The body cap is 10,000 code points for a local comment** (Lemmy's); a peer's comment is kept up to `markdownMaxLength`, through B1's `remoteBody`.
10. **`content_html` is rendered against the stored local origin** (`localInstance`), as B1 does, not `publicOrigin()` as the brief wrote.
11. **Sort and `?sort=`.** B1's route validates only `error`, and `loadPost` is a server function that cannot see the page's query on a client-side navigation. So the loader's call reads the sort from the document request (`getRequest().url`), and `ThreadSection` reads `sort` from the router location: when it differs from the sort it was loaded with it fetches that sort through `loadThreadFn` (a GET server function) and shows the old order until then. The sort control is a GET form of four submit buttons, so it works with no script (a full page load to `?sort=top#comments`); hydrated it navigates through the router. ArkType passes undeclared search keys through, so B1's route needs no change. The permalink route validates `sort` itself and passes it to its loader through `loaderDeps`.
12. **Refusals without JavaScript** redirect with `?commentError=<code>#comments` (a code other than `error`, which is B1's), shown above the reply bar.
13. **The thread's stylesheet is a plain `<link rel="stylesheet">` in the section.** A `precedence` link makes React hold the whole Suspense boundary back until a script reveals it, which hides the page without JavaScript (found by the no-script sort test). `post.css` is B1's page link and could not take my rules without editing B1's route.
14. **Author edit and delete live on the permalink page** (plain forms), and moderators see the reason for a removal in a "Removed by moderators" list under the thread. `CommentThread` has no slot for per-comment actions or for a removal note (requests 3 and 4).
15. **Path labels are the comment's uuid with its hyphens** (as `lab-live` stores them); AZ's `seedComment` uses underscores. Nothing parses a label back.
16. **No restore for a deleted comment.** The brief lists `comment.update` and `comment.delete` only, and `events/comments.ts` has no `comment.restored`. A peer's Undo(Delete) of a comment has nothing to call (section 8, FED-B).
17. **`views.ts` meanings:** `CommentView.depth` is 0 for a top-level comment (`nlevel(path) - 1`, absolute, also on a permalink page); `counts.comments` is `child_count`; `counts.upvotes` and `downvotes` include the author's own vote.
18. **Duplicated on purpose:** `emailUnverified` is B1's helper copied into `authz/actions/comments.ts` (B1's is not exported and is not mine). Request 8 hoists it.

## 5. Requests to root

1. **No table, no migration.** `git status` is clean under `packages/core/drizzle/`.
2. **README, ownership table, row D:** `packages/core/src/comments/**`, `packages/core/src/authz/actions/comments.ts`, `packages/schema/src/{refusals,events}/comments.ts`, `packages/web/src/routes/post/$id/comments/**`, `packages/web/src/i18n/comments.json`, `packages/core/src/testing/seed-d.ts` (also a CLI: `node packages/core/src/testing/seed-d.ts e2e`), `e2e/comments/**`, and the three lines in B1's post page below.
3. **UI, `ReplyBar` (`packages/ui/src/components/reply-bar.tsx`):** keep what was typed when `onSubmit` rejects, and catch the rejection:

   ```ts
   try {
     await onSubmit(body);
     setBody('');
   } catch {
     // The caller shows the error (the `error` prop); the text stays.
   }
   ```

   Today `await onSubmit(body); setBody('')` clears nothing on a rejection but leaves it unhandled in the console. `ThreadSection.reply` throws on a refusal for exactly this reason; without the catch a refused reply logs "Uncaught (in promise)" in the browser. Nothing else in D depends on the change.

4. **UI, `CommentThread` (optional):** a slot for per-comment actions beside reply and share (`actions?: (comment: CommentView) => ReactNode`), so the author's edit and delete, and a moderator's remove, can sit on the comment instead of the permalink page; and a way to show why a comment was removed (`removed` could take the moderator's reason, which `readThread` already returns in `ThreadComment.removal`).
5. **Gaps this lane leaves (decide, then a lane):** no "load more" past 300 comments or 6 levels except the continue page; no rate limit on comments (lane A's `identity/throttle.ts` has no `comment` scope; one scope and one `attempt()` in `-form.ts` would do it); no comment moderation controls on the page (AZ's `mod.remove` works on a comment, nothing calls it from the UI).
6. **`e2e/payload/routes.ts`:** add the permalink page, seeded like B1's post:

   ```ts
   const seededPermalink = () => {
     const out = execFileSync('node', ['packages/core/src/testing/seed-d.ts', 'e2e'], {
       cwd: join(import.meta.dirname, '../..'),
       encoding: 'utf8',
     });
     const { posts, comments } = JSON.parse(out) as { posts: { thread: string }; comments: { first: string } };
     return `/post/${posts.thread}/comments/${comments.first}`;
   };
   // { path: '/post/<id>/comments/<commentId>', target: seededPermalink },
   ```

   It loads the same chunks as the post page (127.4 kB of 170).

7. **FIT's `fixtures/set.ts`:** the comment on `FixtureComment.childCount` ("Direct replies in the set") should read "Every comment below, as Lemmy counts" (no value changes: `lab-live` has no comment two levels deep).
8. **Hoist `emailUnverified`** from `authz/actions/posts.ts` and `authz/actions/comments.ts` into `authz/roles.ts` or `state.ts` (B1 and D copies are identical).
9. **After B1's fix branch merges** (it moves the post page's helpers to `routes/post/-page-data.ts`, formats `published` and `edited` in the loader, and makes `data.threadVisible` false under a removed post for everyone but moderators and admins): keep my three lines, resolving the conflict by hand:
   - `-load.ts`: `import { loadThread } from './$id/comments/-thread.ts';` and, in the returned object beside `threadVisible`, `thread: await loadThread({ page, session, renderer }),`. `loadThread` applies the same rule itself (`threadShown`: the gate shows the post and, for a removed post, the viewer moderates), so no thread data is sent under a removed post; `threadShown` can later import B1's `threadVisible` instead of repeating it.
   - `post-page.tsx`: `import { ThreadSection } from '../$id/comments/-ui/thread-section.tsx';` and `{data.threadVisible && data.thread ? <ThreadSection data={data.thread} /> : <div id="comments" className="post-thread" data-slot="thread" />}`.
   - B1's copy `removed.body` ("The comments below stay.") is wrong once the thread is hidden under a removed post. I format no time myself: `CommentThread` prints ages with UI's `Time` (`suppressHydrationWarning`), so the `when()` change does not touch D.
10. Nothing here needs a setting, a dependency or a change to `views.ts`, `entities.ts`, `ids.ts`, `registry.ts` or `site-settings.ts`.

## 6. Requests to other lanes, through root

- **FED-B:** section 8.
- **UI:** requests 3 and 4. UI's per-comment SVG vote icons make a 136-comment page 267 kB of HTML; a sprite for the arrows would shrink it (not blocking; gzip already does most of the work).
- **B1:** request 9.

## 7. Dependencies added

None.

## 8. For later lanes

**Core, `@peblish/core/comments/*`**

- Mutations (`recheck: true`, events from `s/events/comments.ts`, unchanged): `createComment` (`comment.create`, `comment.created`, input `NewComment` = `{ bodyMd, language? }`, answers `{ id, apId }`), `updateComment` (`comment.update`, `comment.updated`, input `CommentEdit`, answers `{ changed }`), `deleteComment` (`comment.delete`, `comment.deleted`, no input), all in `create.ts`, `edit.ts`, `delete.ts`. Their subjects: `{ postId, parentId | null }` for create, `{ commentId }` for the others.
- Services for web: `createCommentAs(principal, { postId, parentId }, input)`, `updateCommentAs(principal, commentId, edit)`, `deleteCommentAs(principal, commentId)` in `actions.ts`; each answers `{ ok: true, ... }` or `{ ok: false, reason }`. Validate with `NewComment` and `CommentEdit` (`input.ts`, pure, with `commentMaxLength` and `maxCommentDepth`).
- Read model: `readThread(postId, viewer, { sort?, rootId?, now?, db? })` in `read.ts` answers `Thread | null`: `comments: ThreadComment[]` (`view: CommentView` with `contentHtml: null`, `body: { kind: 'markdown', source } | { kind: 'html', html, baseUrl } | null`, `removal: { reason } | null` for moderators), `focus`, `moderator`, `truncated`. The caller renders `body` with `createMarkdownRenderer()` (the web `-thread.ts` does) and applies the post's own gate first (sensitive content, removed post).
- Sort: `ThreadSort`, `threadSorts`, `parseSort`, `ThreadSortParam`, `compareSiblings`, `inDisplayOrder` in `sort.ts` (pure). A new sort is a name in `threadSorts` and a case in `compareSiblings`; nothing else changes.
- Counts: `posts.comment_count` is every comment of the post (tombstones included); `comments.child_count` every comment below; both only ever change in `insertComment` (`insert.ts`).

**FED-A (events).** `comment.created` has `parentId` (null for a top-level comment), `local` is the row's `local`. A local comment's own upvote follows as a second event, `vote.cast`, in its own transaction, as for posts. `comment.updated` is emitted only when the text or language changed. `comment.deleted` is a soft delete; the row, its `ap_id` and its replies stay. Read the comment from `comments` by id (`body_md`, `content_html`, `language`, `edited_at`, `deleted_at`, `removed_at`, `parent_id`); `content_html` is rendered in core against the stored origin with no image rewrite.

**FED-B (inbound).**

- Create: `resolveReplyTarget(record.inReplyToApId)` gives `{ postId, parentId }` or null (skip the Note, or fetch the missing object first). Check that the record's community is the post's community (the mapping README's list). Authorize `comment.create` as `{ kind: 'remote', actorId, announcedBy }` with that subject, then `storeRemoteComment(grant, record)`. `record` is a mapped `CommentRecord`; `RemoteComment` is its structural subset (`apId`, `inReplyToApId`, `bodyMd`, `contentHtml`, `language`, `publishedAt`, `editedAt`, `raw`). It answers `{ id, created }`; `created: false` is a redelivery (nothing changed, nothing emitted). It throws a `TypeError` when the record does not reply to what the grant names.
- Refusals to record as skipped: `comment.depth_exceeded` (the Note is on level 51), `post.locked`, `community.banned`, `target.deleted` and `target.removed` (the post or the parent is gone), `comment.group_cannot_act` (a Group as author), `mod.announce_mismatch`, `target.not_found`. A `Refused` in a consumer is permanent (README).
- Update by the author: authorize `comment.update` with `{ commentId }`, then `updateRemoteComment(grant, record)` (`{ id, changed }`; the record's `apId` must be the comment's).
- Delete by the author: `comment.delete`, then `deleteComment(grant, undefined)`. A Delete by anyone else is a removal: AZ's `removeContent` with `{ reason: summary }`. `target.deleted` on a repeat is a no-op to treat as such.
- Undo(Delete) of a comment has no mutation (decision 16): skip it with a reason, or ask for `comment.restore` (a policy like `post.restore`, a mutation, and `comment.restored` in `events/comments.ts`; about 40 lines).
- A peer's Like on a comment is B1's `castVote` with a comment target, as before.

**COMPOSER, C1.** Nothing to call. A comment form is the docked reply bar; its endpoint is `POST /post/<id>/comments` (`-form.ts`: `intent` reply, edit or delete). `counts.comments` on a post is `posts.comment_count`.

**The web, for any page that shows a thread.** `loadThread({ page, session, renderer, sort?, rootId? })` (`routes/post/$id/comments/-thread.ts`, server only) returns `ThreadData` (all JSON: `comments`, `focus`, `truncated`, `reply`, `viewerId`, `removals`, `own`) or null, and `<ThreadSection data={...} />` draws it. The comment paths are `commentPath(postId, commentId)` in `shell/paths.ts`.

## 9. Left open and risks

- **A refused reply logs an unhandled rejection** in the browser console until request 3 lands. The text stays and the message shows.
- **A post with more than 300 comments within 6 levels shows the first 300** (`truncated` and a hint), with no way to reach the rest from the post page except the continue links of the comments that were cut. Fine at beta scale; a keyset page of top-level comments is the fix.
- **The moderator's reason for a removal comes from the community's newest 200 modlog rows** (`readModlog`'s limit), so an older removal shows "No reason given". A modlog read by target would close it (AZ).
- **A sort change fetches twice** when it goes through the router: the loader reruns `loadPost` (which sends the default sort) and `ThreadSection` fetches the sort asked for. One more request, no visible effect.
- **Hot ranks are computed at read time against the clock**, so two requests a minute apart can order close siblings differently. Fine; Lemmy refreshes its rank on a schedule.
- **No comment rate limit** (request 5).
- **The thread is `private, no-store` with the post page**, like the post (B1's note); a signed-out cacheable variant is a later optimisation.
- **An imported comment** (feddit.com archive) needs `child_count` set as descendants; the import lane should call `recount` logic (`seed-d.ts` has one in SQL) or compute them while importing.
