# Wire mapping

Pure functions between the ActivityPub documents peers send and the rows peblish stores. No
database and no network: `fromWire(json)` (`document.ts`) turns a document into a record,
`toWire(record)` turns a record into the document peblish sends. Records (`records.ts`) are
the stored fields of a row, the schema entity plus the table's other columns, with references
to other rows as ap_ids; the store resolves those, assigns ids and keeps `raw` as received.

| File          | Maps                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `actor.ts`    | Person, Group (a community), Application, Service; a community's moderators collection                        |
| `content.ts`  | Page (also Article, Video) to a post, Note to a comment                                                       |
| `activity.ts` | Create, Update, Like, Dislike, Follow, Accept, Reject, Announce, Delete, Undo, Lock, Flag, Add, Remove, Block |
| `wire.ts`     | ArkType schemas of what peers send (unknown keys pass through and stay in `raw`)                              |
| `language.ts` | `language` objects and `contentMap`                                                                           |

A document the mapping cannot read throws `MappingError` naming the field or the problem.
Besides a wrong shape, it refuses:

- **A URL scheme other than https** in an IRI: ids, inboxes, outboxes, collections, key ids
  and owners, references and addressing (`Iri` in `wire.ts`). Plain http passes only in local
  development, under the instance origin's rule: `PEBLISH_ALLOW_HTTP_ORIGIN=1` and a
  localhost or `*.test` host. Actor icons and banners may be http or https. A post's link or
  preview image in another scheme (`javascript:`, `data:`, `file:`) maps to `null` instead,
  so the post still arrives without it (`webUrl()`).
- **Activities nested more than three levels** below the top-level one; Announce(Undo(Like))
  uses two (`activityFromWire()`).

peblish speaks the Lemmy 0.19 dialect to every peer, because every threadiverse server reads
it. The round-trip tests (`../test/roundtrip.test.ts`) map each captured document in
`../test/fixtures/manifest.json` to its record and back; the only differences allowed are the
ones `../test/vocabulary.ts` documents, each with what the schema should do about it.

## What the caller checks

The mapping reads one document at a time and trusts none of it beyond its shape and URL
schemes. It does not compare origins, so FED-B's inbound handler checks, before it stores a
record or applies an activity:

- **One origin per actor.** The actor's `id`, its `inbox` (and outbox and collections), its
  key's `keyId` and the key's `owner` (`publicKey.ownerApId` in the record, kept as sent) are
  on one origin, and the owner is the actor itself.
- **Embedded activities.** An activity inside Announce, Undo, Accept or Reject is on the same
  origin as its own actor, unless it is fetched from its origin; the outer actor of an Undo
  is the inner activity's actor.
- **The claimed community.** `communityApId` is what the activity claims (`audience`, or the
  Group in `to` and `cc`); it must be the community of the target post or comment, and an
  Announce's actor must be that community.
- **The signer.** The HTTP signature's key belongs to the top-level activity's actor.

## Dialect differences and where they are handled

Each item: the difference, who shows it, and where the mapping deals with it.

- **@context.** Lemmy sends `join-lemmy.org/context.json`, PieFed ActivityStreams plus
  security, Fedify a large inline context. Inbound reads compact terms by name and never
  expands JSON-LD; outbound sends `LEMMY_CONTEXT` on the top-level document only
  (`vocabulary.ts`, `toWire`).
- **One value or an array.** Fedify collapses one-element arrays; Lemmy sends arrays and its
  parser requires them in places (`attachment`, the `to` and `cc` of Create). The address
  schemas and `many()` read both (`wire.ts`); outbound always sends arrays. Some peers name the
  Public collection `as:Public` or `Public`; `isPublic()` reads all three.
- **The community of a post or comment.** `audience` (Lemmy, PieFed, Mbin), else the Group in
  `to` and `cc`: `communityOf()` in `content.ts`.
- **A Group's moderators collection.** `attributedTo` (Lemmy), `moderators` (Mbin), both
  (PieFed): `actorFromWire()`. Outbound sends `attributedTo`, as Lemmy does.
- **Lock and pin.** Lemmy 0.19 leaves `commentsEnabled` and `stickied` off the Page and
  federates `Lock` and the featured collection instead; PieFed sends both. A missing flag maps
  to `null`, meaning keep the stored value, never `false` (`postFromPage()`). Outbound always
  sends both flags.
- **Lemmy vocabulary peblish sends.** `commentsEnabled`, `stickied`, `sensitive`, `language`,
  the full Public IRI in `to`, `cc` and `attachment` even when empty, `distinguished` on Notes:
  `postToPage()`, `commentToNote()`, `addressing()`.
- **Addressing per verb** (Lemmy). Create and Update go to Public with the community in `cc`;
  so do Delete (Lemmy checks the Public IRI in a Delete's `to`), Lock, Add, Remove and Block.
  Like and Dislike carry `audience` only; Follow goes to the followee, Accept to the follower,
  Flag to the community, Announce to Public with the followers collection in `cc`:
  `addressing()` in `activity.ts`.
- **Links and images.** A link post's link is the first `Link` attachment's `href`, with
  Lemmy's `mediaType` when sent; an image post sends an `Image` attachment with `url`, usually
  `mediaType` and the alt text in `name` (Lemmy, PieFed, Mbin, Mastodon). PieFed leaves
  `mediaType` off, which maps to `image/*` (`IMAGE_TYPE`) so the post stays an image post.
  The preview image is the Page's `image`. `postFromPage()` reads them into `url`,
  `urlContentType`, `altText` and `thumbnailUrl`; outbound sends an Image when the content
  type is an image type, else a Link, as Lemmy does.
- **Not safe for life.** PieFed's `nsfl` on Pages (and in its archive, on communities):
  `posts.nsfl` and, for a Group, `actors.nsfl`. Outbound sends it on every Page and Group.
- **Search consent.** `discoverable` and `indexable` (Mastodon, PieFed Persons). Absent reads
  as true, the columns' default, because Lemmy never sends them; outbound sends both on every
  actor, because Mastodon reads an absent flag as an opt-out.
- **Community languages.** A Group's `language` array (Lemmy, PieFed) maps to the record's
  `languages` codes, for `community_languages`; outbound sends it back with the native names.
- **Posting warning.** PieFed's `postingWarning` on a Group: `actors.posting_warning`.
- **Language.** `{ identifier, name }` with the language's own name (Lemmy, PieFed), or only
  `contentMap` (Mbin, Mastodon): `language.ts`.
- **Timestamps.** Microseconds with `Z` (Lemmy), `+00:00` (PieFed). Read into `Date`, which
  keeps milliseconds; the round-trip diff compares instants to the millisecond.
- **Removal is a Delete.** A moderator's removal is a `Delete` by someone other than the
  author, with the reason in `summary`; `Undo(Delete)` restores (Lemmy, PieFed). The Delete
  keeps `reason`; the store compares the actor with the author to choose deleted or removed,
  as `tools/fixture-import/src/lab-live.ts` does.
- **Undoing a vote.** Lemmy's `Undo(Like)` embeds a freshly minted Like id, not the
  original's: match a vote by voter and target, never by the Like id.
- **Announce shapes.** A community announces each activity, `Announce(Create(Page))`
  (FEP-1b12: Lemmy, PieFed, peblish). Lemmy also sends every follower `Announce(Page)`, which
  Mastodon needs and Lemmy itself rejects. `activityFromWire()` reads both. Outbound,
  `announceJson()` relays another server's activity as received (Fedify's serializer must not
  touch it), and an Announce whose object is a Page is the Mastodon copy, for Mastodon-like
  followers only (FED-A picks the shape per follower's NodeInfo software).
- **Accept and Reject** embed the Follow, Lemmy and PieFed with `to: null` in it. The Follow
  must be embedded; null equals absent.
- **Bans.** `Block` with the community or instance as `target`, `removeData`, and `expires`
  (Lemmy) or `expires` and `endTime` (PieFed); Lemmy leaves `removeData` off the Block inside
  its Undo. The Block variant keeps `removeData` as `null` when absent.
- **Bots** are `Service` actors (Lemmy, PieFed): `bot` comes from the type.
- **Reports.** `Flag` with the reason in `summary`, Lemmy adding `content: null`: the
  record's `reason`. The category is lane REP's to assign.
- **PeerTube-style authors.** `attributedTo` as an array of Person and Group objects:
  `author()` in `content.ts` takes the Person.
- **PieFed extras.** `genAI`, `flair`, `interactionPolicy`, `contentMap`, `url` and the
  community settings are not mapped and stay in `raw`; `../test/vocabulary.ts` says for each
  whether the schema should gain a column.
- **Lemmy's own log.** Its `sent_activity` table stores activities without `@context`; only
  the fixtures see this (`lemmy.stored-without-context`).

## Not mapped yet

- A Note that replies to nothing: a Mastodon status or an Mbin microblog post addressed to a
  community. Lemmy and PieFed turn these into posts (PieFed's archive holds 203 from
  Mastodon); peblish needs a rule for the title first. `fromWire` throws `MappingError`.
- An Announce of a bare IRI (Mbin and Mastodon boosts are a Person announcing an IRI): fetch
  the object, then map it. A Person's Announce is a boost, not a community relay.
- PieFed polls (`Question`), Lemmy private messages (`ChatMessage`), and an Accept that names
  the Follow by IRI only.
- Mbin 1.11: no wire capture exists yet (the live run only had fedia.io accept a Follow). Mbin
  content in the archive is PieFed's copy. Known Mbin traits the mapping already reads:
  magazines at `/m/<name>` naming `moderators`, the shared inbox `/f/inbox`, `contentMap`.
