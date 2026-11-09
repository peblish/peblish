# Lane F notes (wave 2): local communities, core half

Plan row F (M14), branch `mvp-w2-f` from `mvp-w2` at 485f084, port 18308, database `peblish_f`. The brief's six items are done, plus moderator management, which the task message from root named. No web route exists: they wait for the R2 pick, as briefed.

## 1. What landed

| Deliverable                                                                  | Where                                                                                           | Proof                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policies `community.create`, `.update`, `.set_moderator`                     | `packages/core/src/authz/actions/communities.ts`                                                | the policy tables in `create.test.ts`, `update.test.ts`, `moderators.test.ts`                                                                                                                            |
| Refusals                                                                     | `packages/schema/src/refusals/communities.ts` (4 new reasons)                                   | exact reasons asserted in the tables                                                                                                                                                                     |
| Input schema `CommunityInput` (pure ArkType)                                 | `packages/core/src/communities/input.ts`                                                        | the `community.invalid` rows in `create.test.ts`, `update.test.ts`                                                                                                                                       |
| `community.create` (mutation `createCommunity`, service `createCommunityAs`) | `communities/create.ts`, `fields.ts`                                                            | `create.test.ts`: endpoints, sidebar, languages, rules in order, owner row, `actor.created` in the same transaction (xmin check), keypair signs and verifies, name rules, race, stale admin grant        |
| `community.update` (`updateCommunity`, `updateCommunityAs`)                  | `communities/update.ts`                                                                         | `update.test.ts`: patch keeps untouched fields, null clears, languages and rules replaced in order, `actor.updated` with `kind: 'Group'` in the same transaction, stale moderator refused by the recheck |
| Rules table `community_rules`                                                | `communities/tables.ts`                                                                         | rules order tests; migration below                                                                                                                                                                       |
| Moderator management (`setModerator`, `setModeratorAs`)                      | `communities/moderators.ts`                                                                     | `moderators.test.ts`: policy tables, appoint, promote, remove, modlog, `mod.role`, cache forgotten, recheck, parallel edits and role changes without a deadlock                                          |
| Read models `readCommunity`, `listLocalCommunities`, `listModerators`        | `communities/read.ts`                                                                           | `read.test.ts`                                                                                                                                                                                           |
| `postingRestrictedToMods` end to end                                         | `communities/posting-restriction.test.ts`                                                       | skipped until B1 merges (item 14 of section 4); verified against a throwaway stand-in for B1's policy (2 of 2 pass), then removed                                                                        |
| Seeds, strings                                                               | `testing/seed-f.ts`, `packages/web/src/i18n/communities.json` (error messages in `en` and `de`) | used by the tests                                                                                                                                                                                        |

## 2. Commits

| Commit  | Message                                                                     |
| ------- | --------------------------------------------------------------------------- |
| dbb75b5 | Add the community refusals, input schema and rules table                    |
| 436a25d | Add the community create, update and moderator policies                     |
| 226d114 | Add community.create with its keypair, owner, languages and rules           |
| bfefd94 | Add community.update as a patch that emits actor.updated                    |
| ce1cf3d | Add community moderator management with the modlog and mod.role             |
| 2573196 | Add the community read models: one community, the local list and moderators |
| 55ebae5 | Prove postingRestrictedToMods end to end once post.create enforces it       |
| 02fcbdd | Add the communities message catalogue for the form errors                   |
| 9939043 | Expose a community's icon and banner URLs in its read model                 |
| (this)  | This file                                                                   |

Each commit's own tree was checked with `git rebase --exec` (schema and core typecheck, Prettier and oxlint on the touched files, the community tests and the mutation-registry test). The full `pnpm check` ran on the final tree.

## 3. Verification

- `pnpm check` is green on the final tree, run with `PEBLISH_MIGRATIONS_DIR` pointing at the scratch copy of the migrations plus `0004_communities.sql` (request 1): build, typecheck, boundaries (336 modules, no violations), oxlint, Prettier, and 1,135 tests passed in 67 files. 4 tests in 2 files are skipped: FIT's opt-in build test (2 tests, as in the groundwork) and my `posting-restriction.test.ts` (2 tests, waiting for B1). The groundwork had 1,100 passed; the 35 new are `create.test.ts` 14, `update.test.ts` 8, `moderators.test.ts` 7 and `read.test.ts` 6. The mutation-registry test passes with the three new mutations (all `recheck: true`).
- The community tests alone: `pnpm exec vitest run --project core src/communities`.
- The parallel edit and role change test ran three times in a row without a deadlock (40P01).
- `pnpm e2e` was not run: this lane adds no route.

## 4. Decisions and deviations

1. **Added, not in the brief: moderator management.** Root's task message listed it. Action `community.set_moderator` (subject: community, actor, role `owner`, `moderator` or `null` to remove), mutation `setModerator`, service `setModeratorAs`. Allowed: a site admin (two-factor) or an owner. Moderators cannot appoint. The target must be a live Person, not yourself (`target.protected`, which also keeps the last owner from leaving), not the instance actor, and not banned when appointed (`target.banned`). Same role again is `community.role_unchanged`. It writes a modlog row (action `community.set_moderator`, public unless `public: false`) and emits AZ's `mod.role` with that modlog id. The role is in the subject, so a grant to appoint a moderator cannot make an owner. A remote Person may be appointed to a local community; the row is `source: 'local'` with no expiry.
2. **The action is not named `mod.*`.** `role-table.test.ts` (AZ's) fails for any `mod.*` policy without a column, and I may not edit it. `recheck: true` is set explicitly instead. Root may rename it later with a column added.
3. **Update authority is `moderationAuthority`** (AZ): site admin (`siteRole` from the session or the recheck refresh), else a fresh owner or moderator. An admin without two-factor therefore reads as a plain user on update (`mod.moderator_required`), because the session never reports `admin` without two-factor. Create uses lane A's check, copied (`denyUnlessAdmin` is private to `identity.ts`), so a principal that claims admin while the database has two-factor off gets `admin.two_factor_required` on create. The recheck downgrades it to `auth.admin_required`.
4. **Non-local principals:** create answers `auth.admin_required` (as `invite.create`), update and set_moderator answer `auth.required` (as `post.create`). The system principal gets the same.
5. **`RESERVED_NAMES` applies to admins too**, as briefed. An official `help` or `support` community needs the list changed.
6. **Update is a patch.** Absent key keeps the value, `null` clears a nullable field, `languages` and `rules` replace the whole list. The name never changes. Empty description, warning and rule body are stored as null.
7. **`nsfl` implies `sensitive`** on create and update (the age gate must cover the stricter label), so a patch that clears `sensitive` while `nsfl` is on keeps it on.
8. **Limits** (`input.ts`): display name 1 to 100, sidebar up to 10,000 (Lemmy's), posting warning up to 500, at most 15 rules, rule title 1 to 200, rule text up to 5,000, at most 50 languages as lower-case two or three letter codes. Text is trimmed first. Out-of-limit input is the closed reason `community.invalid` from the services; the mutations assert with ArkType and throw. Web forms should run `CommunityInput` themselves for per-field messages.
9. **Markdown:** `summary_md` and each rule's `body_md` are kept, and `summary_html` and `body_html` are rendered at write time in the federation form (`renderMarkdown` with `baseOrigin` = the instance origin, no image rewrite, as the MD note says). Pages render the source through `createMarkdownRenderer()`; the read model returns both.
10. **URLs:** `featured_url` is `<ap_id>/featured` and `moderators_url` is `<ap_id>/moderators`, next to inbox, outbox and followers. FED-A must route those two paths or change the stored values here.
11. **Read model rules:** a deleted or admin-removed community reads as `null`. `readCommunity` takes any Group by id and a local one by name (any case). `listLocalCommunities` leaves out age-gated communities unless the caller passes `includeSensitive: true`, which it does only for a viewer who declared 16+ and has not hidden NSFW. `subscribers` counts accepted follows of any follower. `listModerators` applies the `fresh` rule of `roles.ts` (copied, request 2).
12. **No `mod.role` for the creator.** The owner row is part of `actor.created`; the moderators collection of a new community is read from the table.
13. **Rendering happens inside the transaction** (a few milliseconds; at most about 85,000 characters across a sidebar and 15 rules). It is admin and moderator traffic.
14. **The posting test is gated on B1.** It skips while `community.posting_restricted` is not in the refusal union and runs on its own once B1's `s/refusals/posts.ts` lands. Its reason checks are plain strings and `rejects.toMatchObject`, so the file typechecks before and after. I proved it with a throwaway stand-in for B1's rule (flag set and the actor is neither admin nor owner or moderator, per B1's brief), applied to `authz/actions/posts.ts` and a `refusals/posts.ts`, then reverted with `git checkout`; nothing of it is in the tree. The test seeds accounts with a verified email, so B1's `auth.email_unverified` check does not interfere.
15. **Dev database:** I applied the scratch migration to `peblish_f` by mistake once, then dropped and recreated it. It carries 0000 to 0003 only. The scratch folder is used for the test database only (`PEBLISH_MIGRATIONS_DIR` set after `lane.sh`).

## 5. Requests to root

1. **Migration.** `packages/core/src/communities/tables.ts` adds one table; `pnpm db:generate` finds it through the `./src/*/tables.ts` glob. What drizzle-kit 0.31.11 generated for me from the 0003 snapshot, on top of nothing else:

   ```sql
   CREATE TABLE "community_rules" (
   	"community_id" uuid NOT NULL,
   	"position" integer NOT NULL,
   	"title" text NOT NULL,
   	"body_md" text,
   	"body_html" text,
   	CONSTRAINT "community_rules_community_id_position_pk" PRIMARY KEY("community_id","position"),
   	CONSTRAINT "community_rules_position" CHECK ("community_rules"."position" >= 1)
   );
   --> statement-breakpoint
   ALTER TABLE "community_rules" ADD CONSTRAINT "community_rules_community_id_actors_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
   ```

   `git status` shows nothing under `packages/core/drizzle/`. My tests ran against a scratch copy of that folder plus this file as `0004_communities.sql`. Without the migration the community tests fail (`relation "community_rules" does not exist`) on a clean checkout.

2. **Optional, `packages/core/src/authz/roles.ts` (AZ's):** export the `fresh` condition (for example as `freshModerator`) and I replace my copy in `communities/read.ts` (`listModerators`). Until then the two must stay in step.
3. **After B1 merges:** run `pnpm exec vitest run --project core src/communities/posting-restriction.test.ts` and check that it reports 2 passed, not 2 skipped. Nothing to edit.
4. **Optional, `packages/schema/src/modlog.ts` (AZ's):** the `ModAction.action` comment says "mod.* action name"; the modlog now also holds `community.set_moderator`. Readers filter by the plain string, so nothing breaks.

## 6. Requests to other lanes (through root)

- **B1:** in `post.create`, read `postingRestrictedToMods` with the community row you already read FOR NO KEY UPDATE, allow a site admin and a fresh owner or moderator (`communityRole`), else `community.posting_restricted`. Set the community's `sensitive` on posts as you planned: `sensitive` on the Group is the age gate and `nsfl` implies it.
- **FED-A:** see section 8. The Group's `featured_url` and `moderators_url` are `<ap_id>/featured` and `<ap_id>/moderators`.
- **COMPOSER:** the picker uses `listLocalCommunities` plus the followed remote ones. A community with `postingRestrictedToMods` is disabled unless the viewer is a site admin or appears in `listModerators(id)`.

## 7. Dependencies added

None.

## 8. For later lanes

Services (what web server functions call; each authorizes, then writes, and returns `Result<T>` with the exact `RefusalReason`):

```ts
// @peblish/core/communities/create
createCommunityAs(principal, { name, ...CommunityPatch }): Promise<Result<{ id; name; apId }>>
// @peblish/core/communities/update
updateCommunityAs(principal, communityId, patch: CommunityPatch): Promise<Result<object>>
// @peblish/core/communities/moderators
setModeratorAs(principal, { communityId, actorId, role: 'owner' | 'moderator' | null }, { reason?, public? }): Promise<Result<{ modlogId }>>
```

Mutations for other callers, which pass a grant from `authorize()`: `createCommunity(grant, { fields, keys })` (the caller generates `keys` with `newRsaKeyPair()` before the transaction), `updateCommunity(grant, patch)`, `setModerator(grant, ModInput)`. Subjects: `community.create` `{ name }`; `community.update` `{ communityId }`; `community.set_moderator` `{ communityId, actorId, role }`.

Events (all `v: 1`, no new types):

- `actor.created` with `kind: 'Group'`, `local: true` on create. FED-A may publish the Group; the owner row is already there.
- `actor.updated` with `kind: 'Group'`, `local: true` on every update. It names no fields: FED-A sends `Update(Group)` from the row. Fields to map: `display_name`, `summary_html` (federation form), `sensitive`, `nsfl`, `posting_restricted_to_mods`, `posting_warning`, `community_languages`, and `community_rules` if it decides to federate rules (Lemmy 0.19 has no field for them; they are stored as `body_md` and `body_html` per rule).
- `mod.role` with `role: 'owner' | 'moderator' | null` on every moderator change: FED-A's `Add` and `Remove` on the moderators collection. AZ's cache consumer already listens.

Read models (`@peblish/core/communities/read`):

```ts
type CommunityDetail = CommunityView & {
  nsfl; postingWarning; summaryMd; iconUrl; bannerUrl; languages: string[]; rules: { position; title; bodyMd; bodyHtml }[];
};
readCommunity({ id } | { name }, q?): Promise<CommunityDetail | null>
listLocalCommunities({ includeSensitive?, limit? }, q?): Promise<(Pick<CommunityView, 'actor' | 'sensitive' | 'postingRestrictedToMods' | 'subscribers'> & { nsfl })[]>
listModerators(communityId, q?): Promise<{ actor: ActorRef; role: 'owner' | 'moderator' }[]>
```

For the community routes: `CommunityInput` (`@peblish/core/communities/input`, pure, safe in a client bundle) validates the form; errors in `i18n/communities.json` are keyed `error.<reason>`; labels wait for the R2 pick. `/c/<name>` for a remote community is not `readCommunity({ name })` (names look up local communities only); use the id.

C1: `subscribers` counts accepted follows of any follower, local or remote; the viewer's followed communities are C1's own query.

FED-B: `readCommunity({ id })` works for remote Groups too (rules empty, `summaryMd` null, `summaryHtml` the stored sanitised HTML).

## 9. Left open and risks

- No mutation deletes or removes a community. `communityDenial` already honours both states; the admin controls (a Group `actor.deleted`, the `community_removals` row) are for MODF or ADM.
- Icon and banner cannot be set (uploads are off); the read model returns what is stored. Remote ones must go through the media proxy.
- A moderator may change the age gate and the posting restriction, as the brief says ("the same fields"). Say so if only owners should.
- The community name cannot change (it is part of the ap_id).
- `peblish_f_test` is built from the scratch migrations; a clean `pnpm check` needs root's migration first.
