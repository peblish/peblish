# Lane FX-INTEROP: notes

Branch `mvp-w3-interop`, worktree `/Users/admin/Projects/feddit-mvp-w3-interop`, cut from tag `w3-fixes` (2566ed1). `lane.sh` name `lab` (database `peblish_lab`, port 18322). Brief `briefs/wave-3/interop.md`, spec "Root decisions on LAB's interop questions" in `fix-lanes.md`. Paths without a package are under `packages/federation/src/`.

## Scenarios, before and after

Before: the fast tier on `w3-fixes` (lab from `make reset`). After: `make check` from `make reset` on the final code. The ids `V2/F5` and `V2/F3` are this lane's.

| Scenario      | Lemmy before | Lemmy after | PieFed before | PieFed after | Mbin before | Mbin after | Rogue before | Rogue after |
| ------------- | ------------ | ----------- | ------------- | ------------ | ----------- | ---------- | ------------ | ----------- |
| P3            | pass         | pass        | pass          | pass         | known       | pass       |              |             |
| C1            | pass         | pass        | pass          | pass         | known       | pass       |              |             |
| C2            | pass         | pass        | pass          | pass         | known       | pass       |              |             |
| V2            |              |             |               |              |             |            | pass         | pass        |
| V2/F5         |              |             |               |              |             |            | (none)       | pass        |
| V2/F3         |              |             |               |              |             |            | (none)       | pass        |
| B1            | pass         | pass        | pass          | pass         | n/a         | n/a        |              |             |
| M1/out        | pass         | pass        | pass          | pass         | known       | known      |              |             |
| M1/in         | pass         | pass        | known         | known        | known       | known (1)  |              |             |
| S1/out        | pending      | pass (2)    | pending       | pass         | pending     | n/a        |              |             |
| S1/in         | pending      | pass        | pending       | known (3)    | pending     | n/a        |              |             |
| S2/out        | known        | pass        | pass          | pass         | pass        | pass       |              |             |
| S3/out        | known        | pass        | pass          | pass         | known       | pass       |              |             |
| R1/in, R1/out | pending      | pass, pass  | pending       | pass, pass   | pending     | pass, pass |              |             |

Every row not listed passed before and after. Totals: before 67 pass, 0 fail, 9 known, 6 n/a, 6 pending (S1 and R1 were one row per peer); after 84 pass, 0 fail, 4 known, 8 n/a, 0 pending. D1: 8 pass both times.

1. A new signature: Mbin's trash now applies here as a removal; its restore sends nothing (`restore: no inbox row for from https://mbin.lab.test/u/mbinadmin`).
2. Lemmy answers peblish's Block and its Undo for a Lemmy user `400 Site bans from remote instance can't affect user's home instance`, by design; the scenario asserts exactly that and the refusal of the user's post here.
3. PieFed 1.8.11 sends a site ban only to instances whose NodeInfo software is `piefed`, `pylova`, `lemmy` or `mbin` (`ban_person` in its tasks); peblish's is `peblish`.

## 1. What landed

| Item | Deliverable                                                                                                                                                                                                                                                                     | Where                                                                                                                                                                             | Proof                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | A Create, Update or Delete in a remote community counts without an Announce when it is signed on the community's host, addressed to the community (activity or object `to`, `cc`, `audience`) and a local person follows the community; any other host still needs the Announce | `inbound/authorize.ts` (`checkContentCommunity`, `fromCommunityServer`), `inbound/handlers/{_content,delete}.ts`, `inbound/reasons.ts`                                            | `inbound/mbin.test.ts` "Mbin's unannounced Create, Update and Delete in its own magazine" (captured Mbin Create; applies; unfollowed is unannounced; another host is unannounced; a Delete by a non-author still needs a moderator); lab P3, C2 on Mbin pass |
| 2    | The community an activity claims is its `audience`, else the target's community wherever `to` or `cc` names it, else the first other address; every community check uses it                                                                                                     | `inbound/authorize.ts` (`claimFor`), `inbound/handlers/{delete,_ban,_collection,_lock,_vote,flag}.ts`                                                                             | `inbound/mbin.test.ts` "Mbin's Delete of its comment on a post here" (captured shape applies; another community named and this one nowhere is still `community.mismatch`); lab C1 on Mbin passes                                                             |
| 3    | A local community's edit goes to threadiverse followers as an Update(Group) by the editor, announced by the community; Mastodon-like followers get the community's own Update                                                                                                   | `delivery/consumer.ts` (`communityEditor`, `onActor`)                                                                                                                             | `delivery/consumer.test.ts` "a community's edit, as Lemmy sends it"; `delivery/corpus.test.ts` "a community's edit is the shape Lemmy sends" (envelope key for key against Lemmy's captured Announce(Update)); lab S3/out passes on all three peers          |
| 4    | The Person Delete of an account carries `removeData: false`, as a deletion here keeps the content (`core/src/identity/delete.ts`); the mapping carries `removeData` on a Delete both ways                                                                                       | `relay/moderation.ts` (`accountDeletion`), `mapping/{records,activity}.ts`, `inbound/handlers/delete.ts`                                                                          | `relay/relay.test.ts` "a local account's deletion ... keeping its content as here"; lab S2/out checks the delivered body                                                                                                                                     |
| 5    | S1 (site ban out and in, a site-banned user's post refused as `auth.site_banned`), R1 (Flag in opens a report, Flag out reaches the peer and Lemmy lists it), V2's tail as a pass or fail; `scenarios/pending.ts` removed                                                       | `tools/interop/src/scenarios/{bans,reports,mastodon,index}.ts`, `peers/{types,threadiverse,mbin}.ts` (`siteBan`, `reported`), `peblish.ts` (`siteBan`, `siteUnban`, `reportPost`) | `make check`, table above                                                                                                                                                                                                                                    |
| 6    | The lab has a Mastodon-like follower (the rogue): V2/F5 (a Lemmy site ban with removeData withdraws the boost) and V2/F3 (a mentioned Mastodon-like person who follows nothing gets the author's Create, then the author's Delete on a moderator's removal)                     | `tools/interop/src/scenarios/mastodon.ts`                                                                                                                                         | `make check`, and a separate run of `ONLY=V2,S3` after the rename (12 pass)                                                                                                                                                                                  |
| 7    | Dropped by root mid-lane (FR-A replaces it)                                                                                                                                                                                                                                     | none                                                                                                                                                                              | see deviation 1                                                                                                                                                                                                                                              |

Also: the lab scenarios the fixes settle (`7310786`), `INTEROP.md` (scenario table, latest results, peer findings), `lab/README.md` (no scenario is pending), `packages/federation/README.md` (authorization, community edits), `mapping/README.md` (`removeData` on a Delete).

## 2. Commits

```text
766af75 Find the community among every addressee of an inbound activity              (item 2)
dcbd6f4 Accept a Create, Update or Delete from a followed community's own host         (item 1)
e3b7bad Send a community's edit as Lemmy does: the editor's Update, announced          (item 3)
db9d96a Say removeData: false on an account's Delete, as a deletion here keeps its content (item 4)
7310786 Turn the lab scenarios the interop fixes settle from known to pass             (items 1 to 4, lab)
21835be Replace the pending lab scenarios: site bans, reports and V2's tail            (item 5)
4104470 Add F5 and F3 against the lab's Mastodon-like follower                         (item 6)
6a903f3 Close the ledger entries F5 and F3 settle themselves                           (item 6, cleanup)
008249e Record the interop results; name the follower scenarios V2/F5 and V2/F3        (docs, rename)
```

This file is the last commit.

## 3. Verification

- `pnpm check` before each commit, green: 2,588 tests on the first, 2,594 passed and 7 skipped (226 files) from item 4 on. Load timeouts rerun alone: on the item 3 commit `packages/core/src/reports/read.test.ts` "the queue answers under 50 ms ... on 5,000 open reports" failed once at load average 12 and passed alone (9 of 9). One earlier run (item 2) was spoiled by my own focused test run on the same test database at the same time; it was rerun clean before that commit.
- `make reset && make check` (reset, up, seed, the fast tier, D1, cleanup): green in 892 s (14.9 minutes, budget 20). Fast tier 84 pass, 0 fail, 4 known, 8 n/a, 0 pending; D1 8 pass; cleanup 73 cleaned, 0 failed. The run before it (881 s) had the same tier result but 2 cleanup failures from V2/F5 and V2/F3, fixed in `6a903f3`.
- After the rename of F5 and F3 to V2/F5 and V2/F3 (`008249e`), `make up` then `make interop ONLY=V2,S3`: 12 pass, 0 fail; cleanup 1 cleaned, 0 failed. A first try right after `make up` failed V2 on Mbin's FrankenPHP not answering for 15 s (the cold start hazard of LAB decision 9); the retry was green.
- `pnpm build && pnpm e2e` on `6a903f3` (the code is unchanged since): 323 passed and 1 skipped (parallel), 33 passed (serial).
- The slow tier F3 (Follow resend) was not rerun: nothing it touches changed.
- The lab ran on its internal network only; nothing contacted a live peer, `lab.feddit.com` or any public server. `make down` at the end: no lab container runs, the images (`peblish:lab`, `feddit-lab/interop:dev`, `feddit-lab/piefed:1.8.11`, Lemmy, Mbin) are kept.

## 4. Decisions and deviations

1. **Deviation (root, mid-lane):** item 7 was dropped (FR-A stores the disclosed hosts with each report). My edits to `core/src/reports/form.ts`, `delivery/reports/consumer.ts` and its test were never committed; I restored the three files from `w3-fixes` in the working tree, so no revert commit was needed and the branch never touches `packages/core/src/reports/**` or any FR-A file.
2. Item 1, "signed on the community's host": the key's owner is the activity's actor (`receive.ts`), and the pipeline holds the activity's id to the actor's origin, so the check compares the sender's host with the community's (`URL.host`, port included). "Addressed to" accepts the community in the activity's or the object's `to`, `cc` or `audience` (Mbin puts it in both). "Followed" means an accepted follow by a local actor, read in `prepare`.
3. Item 1 gives no Announce authority: the principal keeps `announcedBy: null`, so a removal from the community's host still needs a moderator core knows (mirrored). Mbin's owner is mirrored, so its trash of a user's post applies as a removal. Undo, Lock, Add, Remove and Block from the host still need the Announce, as decided.
4. Item 2 applies to every verb's community check, not only Delete: the claim is read the same way everywhere (votes are unchanged, as they only read `audience`).
5. Item 1 changes the corpus replay (`inbound/corpus.expected.ts`): Lemmy's own direct copies to its community's inbox (`peer-log/lemmy-sent_activity-*`) now count from the community's host; Creates come out `object.exists`, the Update `applied` (so `inbound-0026` is now `duplicate`), one Delete `target.deleted`, a moderator's Delete `mod.moderator_required` (no mirrored moderators in the replay). `pipeline.test.ts` drops its direct-copy assertion, which `mbin.test.ts` now covers both ways.
6. Item 3: the event names no editor, so the actor is the local person on the newest `community.update` modlog row of the community (written in the edit's transaction), else its owner, else a moderator; two edits close together may both go out under the later editor (both are staff, harmless). With no local staff at all the community's own Update goes to everyone, as before. Lemmy 0.19 accepts any person of the community's domain (`verify_mod_action`), and Lemmy, PieFed and Mbin all send theirs this way (captured in the lab's `inbox_raw`). The inner Update is stored, so it is served at its id.
7. Item 4: `removeData: false`, not absent: local deletion keeps the posts and comments, and Lemmy reads the flag. S2/out now asserts the delivered body says so and notes what the peer does (Lemmy keeps the post, PieFed and Mbin hide it) instead of requiring the post to vanish.
8. S1/out on Lemmy is a pass that asserts Lemmy's exact 400, not a `known`: refusing a remote ban of its own user is Lemmy's design, not a defect. Whether peblish should skip the banned person's home instance is left open (section 9).
9. S1 on Mbin is `n/a`: Mbin's API users are bots, stored as Service actors, and core's site ban policy targets a Person (`authz/actions/bans.ts`, `target.not_found`); Mbin's own site ban needs the `admin:user:ban` scope, which the lab's clients do not request.
10. **Deviation:** the brief named the Mastodon scenarios F5 and F3, the review finding ids. The slow tier already uses the scenario id F3, so `--only=F3` (`make interop-slow`) would have run the new one too. They are `V2/F5` and `V2/F3`: `ONLY=V2` runs all three, and they need V2's follow anyway. Renamed after the last `make check`, then rerun alone (section 3).
11. M1/in on Mbin uses a post by Mbin's ordinary user: Mbin's trash is a bare Delete with no reason, so a trash of the moderator's own post is the author's own Delete on the wire. It expects the moderator's direct activities instead of the community's Announces.
12. V2 and V2/F3 read only the rogue's shared inbox (`/inbox`): a rogue inbox fixture (`queried`, from H1) keeps following !lab across runs and got its own Announce(Page). The group also waits for the follower's Undo(Follow) to apply before V2/F3 posts, or the post still reaches it as a follower.
13. B1's `n/a` reason on Mbin now says why (bots cannot vote down), not that Mbin never announces.

## 5. Requests to root

1. **Optional, product:** core's site ban refuses a non-Person target (`packages/core/src/authz/actions/bans.ts:89`, `if (!person || person.kind !== 'Person') return deny('target.not_found')`). Mbin's API users and other bots are Service actors, so they cannot be site-banned here. If they should be, the exact change is `if (!person || (person.kind !== 'Person' && person.kind !== 'Service')) return deny('target.not_found');` with a test; I did not make it (outside my write set, and it is a policy choice).
2. **Optional, schema:** `actor.updated` names no actor. A `byActorId` (uuid or null) on it, set by `communities/update.ts`, would let `delivery/consumer.ts` name the editor without reading the modlog. Not needed for correctness today.
3. Plan or README text, if wanted: INTEROP.md now records that Lemmy refuses a remote instance's site ban of its own user (400) and that PieFed sends site bans only to the software it lists.
4. No migration, no schema change, no settings key, throttle scope or payload route. No change under `packages/core/`.

## 6. Requests to other lanes, through root

- FR-A: R1/out sends a forwarded report about a post in the peer's community and expects one Flag delivered to the peer's host. If FR-A changes which hosts an outbound Flag goes to, the scenario still holds as long as the community's host is among them.

## 7. Dependencies added

None.

## 8. For later lanes

- `checkContentCommunity(ctx, community, claimed)` (`inbound/authorize.ts`) is `checkCommunity` plus the community's-host exception; use it only for Create, Update and Delete. `claimFor(ctx, community)` is the claim to pass to either.
- The lab: `make interop ONLY=V2` runs V2, V2/F5 and V2/F3; `ONLY=V2/F5` alone fails (no follow). `peer.mod.siteBan` is absent on Mbin; `peer.mod.reported` returns null where the API cannot list reports (PieFed, Mbin).
- Mbin escapes `/` in its JSON; `expectInbound`'s `contains` already searches the unescaped body, `expectDelivery`'s searches peblish's own bodies.
- A scenario that removes or bans something a cleanup step would try to delete as its author must close its ledger entry itself (`ctx.ledger.done`).

## 9. Left open and risks

- Mbin's restore of a trashed post never federates, and Mbin does not apply the undo of a remote removal (both `known`).
- peblish never hears of PieFed's site bans: PieFed sends them only to `piefed`, `pylova`, `lemmy` and `mbin` instances. Nothing to do on our side short of claiming another software in NodeInfo, which I did not consider.
- peblish sends its site ban of a remote person to every peer, including the person's home instance, which Lemmy answers 400. Lemmy itself does the same; skipping the home instance would save one failed delivery per ban. Left as is.
- A same-host Create, Update or Delete is accepted whatever its type of sender (a Service bot of the community's server included), as an Announce from that server would be; a server that hosts the community is trusted for its content either way.
- The community editor read from the modlog can misattribute two near-simultaneous edits (decision 6).
- Mbin's FrankenPHP can stall for a while after `make up` on an existing lab (seen once here); `make check` from `make reset` did not hit it.
