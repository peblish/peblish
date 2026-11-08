# Lane FIT notes

Lane FIT of peblish wave 1 (fixtures, wire mapping and the round-trip tests), branch
`mvp-w1-fit` from `mvp-w1` at 790a03c. Plan row FIT: shares of B01, B02 and B05.

## Commits

| Commit  | What                                                                              |
| ------- | --------------------------------------------------------------------------------- |
| 79eae20 | Add arktype to federation and the fixture-import tool package (with the lockfile) |
| 69fd9a2 | Add the structural diff for wire round trips                                      |
| 0442cbc | Map Lemmy, PieFed and Mbin wire documents to peblish records                      |
| b3617d6 | Add the fixture set format and its loader                                         |
| 4f7e74e | Build the federation corpus and lab-live from the spike captures                  |
| 8cbe26b | Round-trip a subset of the feddit.com archive                                     |

## What landed

| Deliverable (brief item)           | Where                                                                                                                                          | Status                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1. Manifest format and manifest    | `packages/federation/src/test/fixtures/manifest.schema.ts` (ArkType), `manifest.json` (164 entries), the wire documents under `fixtures/wire/` | done                                                                      |
| 2. Wire mapping, both directions   | `packages/federation/src/mapping/`                                                                                                             | done for Lemmy 0.19 and PieFed 1.8; Mbin 1.11 has no wire capture (below) |
| 3. Round-trip tests                | `packages/federation/src/test/roundtrip.test.ts`, one test per manifest entry                                                                  | done, all pass                                                            |
| 4. Fixture loader and lab-live set | `packages/core/src/fixtures/{set,load}.ts`, `sets/lab-live.json`, `packages/core/src/testing/seed-fit.ts`                                      | done                                                                      |
| 5. Command-line tool               | `tools/fixture-import/` (`build` and `archive`)                                                                                                | done; archive run passes locally                                          |
| 6. Dialect README                  | `packages/federation/src/mapping/README.md`                                                                                                    | done                                                                      |

Verification on the final tree:

- `pnpm check`: green (with `FIXTURE_CAPTURES_DIR` and `FEDDIT_ARCHIVE_DB_URL` set, so the
  build-drift and archive tests ran too; without them those two skip, as in CI).
- Every one of the 164 manifest entries round-trips with no difference outside the
  documented vocabulary.
- Archive run: 684 documents, 0 unmappable, 0 undocumented differences (table below).
- `node tools/fixture-import/src/cli.ts build` rebuilds the committed corpus byte for byte
  (`tools/fixture-import/src/build.test.ts`).

## The corpus

From the Docker lab captures of the Phase 0 spike (slices 1 and 2):

- **Lemmy 0.19.21, 76 entries** (59 inbound, 5 fetched, 12 from Lemmy's own `sent_activity`).
  Direct: Accept(Follow) 3, Add 2, Block 2, Create(Note) 4, Create(Page) 7, Delete 4,
  Dislike 1, Flag 1, Follow 3, Like 2, Lock 2, Remove 2, Undo(Block) 2, Undo(Delete) 2,
  Undo(Like) 2, Undo(Lock) 2, Update(Page) 2. Announced by a community: Announce(Page) 6,
  Announce(Create(Page)) 4, Announce(Delete) 4, Announce(Create(Note)) 2,
  Announce(Update(Page)) 2, and one each of Add, Block, Like, Lock, Remove, Undo(Block),
  Undo(Delete), Undo(Like), Undo(Lock), Update(Note). Documents: Group 1, Person 2, Page 1,
  OrderedCollection 1.
- **PieFed 1.8.11, 39 entries** (35 inbound, 4 fetched). Direct: Accept(Follow) 2, Add 1,
  Create(Note) 3, Create(Page) 3, Delete 2, Dislike 1, Flag 1, Follow 2, Like 1, Lock 1,
  Remove 1, Undo(Delete) 1, Undo(Dislike) 1, Undo(Like) 1, Undo(Lock) 1, Update(Page) 1.
  Announced: Announce(Create(Page)) 2, Announce(Delete) 2, and one each of Add, Block,
  Create(Note), Lock, Remove, Undo(Delete), Undo(Lock), Update(Page). Documents: Group 1,
  Person 2, OrderedCollection 1.
- **feddit-spike 0.0.1 (Fedify 2.4.5), 49 outbound entries**, what the spike sent Lemmy and
  PieFed and they accepted: Announce(Create(Page)) 16, Announce(Create(Note)) 9, Create(Note)
  2, Create(Page) 2, and one each of 20 other shapes.

By peblish entity: post 49, comment 23, deletion 20, vote 17, follow 12, lock 12, pin 12,
ban 9, actor 4, community 2, moderators 2, report 2.

lab-live (`packages/core/src/fixtures/sets/lab-live.json`): 3 instances (feddit.lab.test,
lemmy.lab.test, piefed.lab.test), 12 actors, 23 posts, 14 comments, 1 vote, 9 accepted
follows, from replaying the corpus in capture order. Only one vote survives because the lab
scenarios undo their votes.

## Decisions and deviations from the brief

1. **The captures are not in the repository.** `.gitignore` has `spikes/*/captures/`, so the
   worktree has none, despite the brief. I read them read-only from the maintainer's main
   checkout (`/Users/admin/Projects/feddit/spikes/fedify-threadiverse/captures`) and the tool
   copies each selected document into `packages/federation/src/test/fixtures/wire/`, which is
   committed, so CI round-trips them. The manifest's `source` records the original file and
   line. That committed copy is now the canonical corpus.
2. **The live runs carry no wire bodies.** The `live-*.json` and `live-*-state.json` files
   (in the `slice-3-live` checkout) hold results, ids and the lab's stored rows and inbox log,
   not JSON as sent; the live lab's capture directory stayed on its Easypanel volume. So the
   corpus and lab-live cover the Docker lab runs only, and nothing from mastodon.social,
   fedia.io or lemmy.world.
3. **Selection.** Traffic from the lab's rogue peer and test harness (user agent `node`,
   `rogue.lab.test`) is authorization testing, so it is left out, as are the spike's relays of
   it. Each document id appears once. The spike's outbound repeats shapes (each with Fedify's
   4 KB context), so the first of each shape is kept, plus every post and comment the spike
   published (lab-live needs them). The moderation and authz result files duplicate
   `inbound.jsonl` and add nothing.
4. **Records, not uuid entities.** The mapping is pure, so it maps to records
   (`mapping/records.ts`): the schema entity's fields (picked from `entities.ts`) plus the
   table's other columns, with references as ap_ids. The store resolves them. The tool's
   lab-live builder shows the resolution.
5. **Unknown is not false.** Lemmy 0.19 leaves `commentsEnabled` and `stickied` off its Pages,
   so `locked` and `featuredCommunity` are `null` in a record when the Page did not say.
6. **Allowed differences.** Each manifest entry's `allowed` list is exactly the differences its
   round trip shows, and each must cite an entry of `packages/federation/src/test/vocabulary.ts`
   whose pattern and change kind match (tested). The build refuses an undocumented one.
7. **Diff equivalences** (`test/diff.ts`): null equals absent; an original scalar equals a
   one-element array holding it (not the reverse, because Lemmy's parser needs arrays);
   timestamps naming the same millisecond are equal (Lemmy sends microseconds); arrays of plain
   values compare as sets; `@context` compares as one value.
8. **Outbound @context** is Lemmy's own pair (`join-lemmy.org/context.json` plus
   ActivityStreams), on the top-level document only.
9. **Update of an actor** (profile and community edits) is mapped and unit-tested although the
   corpus has none.
10. **Archive rendering.** PieFed keeps no received JSON (`activity_pub_log` is empty in the
    archive), so the tool renders each archived row as the document PieFed 1.8 federates for
    it and runs the round trip on that. Remote communities are rendered without PieFed's local
    settings (those are PieFed defaults, not the peer's). Tags are rendered empty.
11. **Archive subset.** The 2 local users and 2 local communities; 130 remote communities a
    local user follows (the brief's 131 counts the local `announcements` membership too); the
    20 newest posts and 20 newest comments of each of the 23 origin softwares in the archive
    (lemmy, piefed, mbin, mastodon, friendica and 18 more). The 11 polls are skipped (no
    mapping for `Question`).
12. **Public keys stay in the fixtures.** The lab actors' public keys are part of the wire
    documents and are public. The guard test asserts no private key block, no `privateKey`,
    `private_key`, `email` or `password` field, and no email address (fediverse handles and
    `name@host` inside URLs allowed). The archive queries never select a private key, email,
    password or IP column, and the archive run writes nothing.
13. **Fixture ids** are deterministic uuidv7s (timestamp from the row, the rest from a hash of
    the ap_id), so a rebuild gives the same ids.
14. **lab-live counters** (upvotes, downvotes, comment_count, child_count) count the set's own
    votes and comments; `child_count` counts direct replies. Lane D may define it differently.
15. **Loading local.** `loadFixtureSet('lab-live')` loads everything remote;
    `{ localDomain: 'feddit.lab.test' }` makes the spike's instance local and drops raw on its
    rows (content authored here has no raw). The test database must not have a local instance
    then.

## Schema deltas for migration 0001

Fields peers send that no column holds, from the corpus and the archive run. Root decides;
my recommendation is in the last column. Everything not listed as a column or table stays in
`raw`.

| Field                                                                                                                                                                      | Seen in                                                  | Recommendation                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Image attachment type and alt text (`attachment[].type: Image`, `name`)                                                                                                    | 34 of 187 archive posts, every software with image posts | `posts.url_content_type text` and `posts.alt_text text` (Lemmy has both), so image posts go out as Image with alt text |
| Link preview image (`image` on a Page)                                                                                                                                     | 60 of 187 archive posts                                  | `posts.thumbnail_url text`, or a `media` row of kind thumbnail linked from the post (B2)                               |
| Community languages (`language[]` on a Group)                                                                                                                              | 75 of 132 archive communities, PieFed corpus             | table `community_languages (community_id, language)`                                                                   |
| Search consent (`discoverable`, `indexable`)                                                                                                                               | both local users                                         | `actors.discoverable boolean` and `actors.indexable boolean`: an opt-out the import and search must respect            |
| Not safe for life (`nsfl`)                                                                                                                                                 | every PieFed Page, both local communities                | `posts.nsfl boolean` and `actors.nsfl boolean`, or fold into `sensitive` at import                                     |
| Mentions and hashtags (`tag`)                                                                                                                                              | 30 Lemmy and 12 PieFed corpus entries                    | a mentions table (and post tags) later; raw for now                                                                    |
| Community posting warning (`postingWarning`)                                                                                                                               | PieFed Groups (none set on feddit.com)                   | `actors.posting_warning text` if the composer shows it                                                                 |
| AI-generated (`genAI`)                                                                                                                                                     | PieFed Pages and Groups                                  | raw, unless peblish filters on it                                                                                      |
| User flair (`flair`)                                                                                                                                                       | PieFed Notes                                             | raw                                                                                                                    |
| PieFed community settings (`contentRetention`, `defaultHashtag`, `defaultPostType`, `postUrlType`, `questionAnswer`, `newModsWanted`, `privateMods`, `lemmy:tagsForPosts`) | local communities                                        | raw; `privateMods` matters if peblish lists moderators                                                                 |
| PieFed person settings (`acceptPrivateMessages`, `attributionDomains`, `manuallyApprovesFollowers`, `reposter`)                                                            | PieFed Persons                                           | raw; `reposter` could set `actors.bot`                                                                                 |

Two more that are not round-trip fields:

- `reports.category` is NOT NULL, but a Flag carries only a reason. Lane REP needs a default
  category for federated reports (or the column must allow null).
- `posts.published_at` and `comments.published_at` are NOT NULL, but a peer may omit
  `published`; records carry `null` and the store should use the receive time.

The archive run's table, as printed by `node tools/fixture-import/src/cli.ts archive`:

Archive subset: 684 documents (2 actors, 132 communities, 187 posts and 363 comments, the
posts and comments from 23 origin softwares).

| Vocabulary                 | Change                  | Kind                                          | Documents | Schema                                            |
| -------------------------- | ----------------------- | --------------------------------------------- | --------- | ------------------------------------------------- |
| image-attachment           | added, changed, dropped | post                                          | 34        | column: posts.url_content_type and posts.alt_text |
| peblish.attachment         | added                   | comment                                       | 363       | none: posts.url                                   |
| peblish.context            | changed                 | actor 2, community 132, post 187, comment 363 | 684       | none: constant                                    |
| peblish.language-name      | changed                 | comment                                       | 1         | none: derived                                     |
| piefed.community-languages | dropped                 | community                                     | 75        | table: community_languages                        |
| piefed.community-settings  | dropped                 | community                                     | 2         | raw                                               |
| piefed.content-map         | dropped                 | comment                                       | 362       | none: derived                                     |
| piefed.gen-ai              | dropped                 | community 1, post 187                         | 188       | raw                                               |
| piefed.moderators          | dropped                 | community                                     | 2         | none: actors.moderators_url                       |
| piefed.nsfl                | dropped                 | community 2, post 187                         | 189       | column: posts.nsfl, actors.nsfl                   |
| piefed.person-settings     | dropped                 | actor                                         | 2         | raw                                               |
| piefed.search-consent      | dropped                 | actor                                         | 2         | column: actors.discoverable, actors.indexable     |
| piefed.url                 | dropped                 | community 2, comment 363                      | 365       | none: ap_ids are the human pages                  |
| tags                       | dropped                 | post 187, comment 363                         | 550       | table: mentions and hashtags                      |
| thumbnail                  | dropped                 | post                                          | 60        | column: posts.thumbnail_url                       |

Not sampled: 11 polls (PieFed post type 5, a Question). Unmappable: none. Undocumented: none.

## Requests to root

1. **Lockfile.** I added `arktype 2.2.9` to `packages/federation/package.json` and created the
   private package `tools/fixture-import` (dependencies `@peblish/core`, `@peblish/federation`,
   `@peblish/schema` as `workspace:*`, `arktype 2.2.9`, `postgres 3.4.9`, `prettier 3.9.10`,
   all versions already in the lockfile), then ran `pnpm install` once. The lockfile change is
   two importer blocks, committed on its own (first commit); regenerate it at integration if
   you prefer.
2. **Migration 0001.** The schema deltas above, as you decide.
3. **README.md, "Adding to an area".** Add this row after "Test seeds":

   ```md
   | Fixture sets | `packages/core/src/fixtures/sets/<name>.json`, written by `node tools/fixture-import/src/cli.ts build`; tests load one with `loadFixtureSet(name)` from `@peblish/core/fixtures/load` | the `fixtureSets` map in `packages/core/src/fixtures/load.ts` |
   ```

4. **Briefs and plan.** The FIT brief says the captures are in the repository; they are
   gitignored. Later briefs should point at `packages/federation/src/test/fixtures/` instead.
5. **Lane REP.** A default category for federated reports (`reports.category` is NOT NULL).

## For FED-A and FED-B

- Inbound: `fromWire(json)` (`@peblish/federation/mapping/document`) or `activityFromWire`;
  a `MappingError` is permanent (record it in `inbox_raw.error`, do not retry). Records name
  other rows by ap_id; resolve them in the transaction. `communityApId` is what the activity
  claims, so check it against the target's community.
- Lock and pin flags are `null` when a Page does not state them: keep the stored value.
- Match a vote by voter and target (Lemmy's `Undo(Like)` carries a new Like id). A Delete by
  someone other than the author is a removal with `reason`; `Undo(Delete)` restores.
- Dedupe an Announce by its inner activity's id (G0 contract 6): `activity.object.id`.
- Not mapped yet, so FED-B decides: a Note that replies to nothing (Mastodon statuses and Mbin
  microblog posts sent to a community; feddit.com's `microblogs` community exists for these,
  and PieFed's archive holds 203 such posts from Mastodon); an Announce of a bare IRI (a
  boost: fetch, or ignore a Person's Announce); `Question` (polls); an Accept naming the Follow
  only by IRI.
- Outbound: `toWire(record)` gives the Lemmy-dialect document with its `@context`.
  `announceJson()` wraps another server's activity unchanged for the FEP-1b12 relay, but it
  works on parsed JSON: the byte-exact relay must splice `inbox_raw.body` into the Announce
  text instead. An Announce whose object is a Page is the Mastodon copy, for Mastodon-like
  followers only.
- Test data: the manifest's wire documents are real Lemmy and PieFed traffic for handler
  tests. They are parsed JSON, not the bytes received, so HTTP signatures and digests cannot be
  replayed from them. `seedLabLive({ local: true })` (`@peblish/core/testing/seed-fit`) seeds
  lab-live with the spike's `c.spike` local; `labLive` names the common ap_ids.
- Mbin 1.11 has no wire capture: B02 should capture Mbin traffic (follow a magazine, post,
  comment, vote) so the corpus can cover it. The mapping already reads Mbin's `moderators`,
  `/m/<name>` actors and `contentMap`.

## Running the tool

```sh
# Rebuild the corpus and lab-live (needs the captures; refuses undocumented differences and secrets)
node tools/fixture-import/src/cli.ts build --captures /Users/admin/Projects/feddit/spikes/fedify-threadiverse/captures

# The archive run, against the PieFed archive restored into its own database
docker compose exec -T postgres createdb -U peblish peblish_fit_archive
docker cp /Users/admin/Projects/feddit-archive/2026-11-08/piefed-db.dump "$(docker compose ps -q postgres):/tmp/piefed-db.dump"
docker compose exec -T postgres pg_restore -U peblish -d peblish_fit_archive --no-owner --no-privileges -j 6 /tmp/piefed-db.dump
FEDDIT_ARCHIVE_DB_URL=postgres://peblish:peblish@127.0.0.1:18432/peblish_fit_archive node tools/fixture-import/src/cli.ts archive

# Both opt-in tests in pnpm check
FIXTURE_CAPTURES_DIR=<captures> FEDDIT_ARCHIVE_DB_URL=<archive url> pnpm check
```

`peblish_fit_archive` is still on the compose Postgres (8.7 GB); drop it when done:
`docker compose exec -T postgres dropdb -U peblish --force peblish_fit_archive`.

## Left and risks

- No Mbin, Mastodon or live-peer wire in the corpus (above).
- The archive round trip runs on PieFed's rendering of its rows, which tests the mapping
  against real archive values but not against bytes any peer sent.
- The vocabulary marks no allowance stale: if the mapping later stops producing a documented
  difference, the manifest still lists it until the next build.
- `reports.category` and the top-level Note rule above need owners.
