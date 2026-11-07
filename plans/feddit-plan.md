# Feddit Definitive Architecture and Delivery Plan

Status: canonical

Last reviewed: 2026-07-26

Supersedes:

- `plans/archive/feddit-plan.original.md`
- `plans/archive/feddit-technical-plan.original.md`

The source plans are archived for historical context only. This is the sole
implementation plan for Feddit. It resolves their open choices, corrects
federation details, removes premature infrastructure, and turns the shared
direction into an executable delivery plan.

## 1. Comparison and decision

### What each source plan does well

| Area | Archived product plan | Archived technical plan | Definitive decision |
| --- | --- | --- | --- |
| Architecture | Strong domain/federation separation and practical app structure | Clear logical layers and protocol responsibilities | Keep a modular monolith with explicit domain, API, federation, and worker boundaries |
| Federation | Good Fedify adapter pattern | Better emphasis on WebFinger, NodeInfo, security, Group behavior, and early interoperability | Build a thin federated vertical slice before broad product work |
| Client | More concrete screens, design system, data layer, and responsive layouts | Correctly emphasizes universal React Native and accessibility | Expo + Expo Router + React Native Web, with Tale UI React Native as the component foundation and web-specific escape hatches |
| API | Concrete REST resources and versioning | Keeps federation and client APIs separate | REST/OpenAPI only for v1; do not add GraphQL yet |
| Operations | Good observability and worker separation | Good security and federation-control coverage | Start with Docker Compose and two deployable processes; defer orchestration and external search |
| Distribution | Mentions open-source documentation and deployability | Mentions licensing and operator guides | Treat self-hosting, upgrades, release artifacts, and downstream app builds as tested product contracts |
| Roadmap | Delivers a useful local product first | Tests protocol assumptions earlier | Use vertical slices: foundation, federation spine, MVP, hardening, mobile release |

### Problems resolved here

1. **Federation cannot be postponed until after a complete local product.**
   ActivityPub identity, canonical URLs, community fan-out, remote authorization,
   edits, deletes, and votes affect the data model. A protocol spike and a
   production-shaped federation spine therefore precede feature breadth.

2. **“Full ActivityPub compliance” and broad Fediverse “feature parity” are not
   useful MVP claims.** Feddit will implement the ActivityPub server-to-server
   subset required by its published interoperability contract. Compatibility is
   proven by fixtures and live tests, not by a blanket claim.

3. **Lemmy-compatible community semantics must be explicit.** Communities are
   `Group` actors. A post is emitted as `Page`, comments as `Note`, upvotes as
   `Like`, downvotes as `Dislike`, and vote removal as `Undo`. A community
   validates addressed content and relays accepted activities to followers using
   `Announce`.

4. **The original technology menus hide decisions.** The initial stack is fixed
   below. Changes require an architecture decision record (ADR).

5. **Kubernetes, OpenSearch, video processing, plugins, multi-host tenancy, and
   broad offline support are premature.** The architecture leaves seams for
   them, but they are not MVP dependencies.

6. **Dynamic community and post pages need discoverable web output.** Expo Router
   is the universal router. Request-time web rendering is still an evolving Expo
   capability, so the MVP must validate it in a spike and retain the option of a
   small web-only rendering shell for public routes.

7. **Open source must mean independently operable.** Publishing source alone is
   insufficient. Releases need portable infrastructure, validated configuration,
   upgrade guarantees, operator documentation, and a supported way to compile
   branded clients without maintaining a downstream fork.

## 2. Product scope

Feddit is an open-source, Reddit-style community platform whose independently
operated instances exchange public communities, posts, comments, follows, and
votes through ActivityPub. The installable instance software and the universal
client are products in their own right: an operator must be able to deploy a
Feddit instance and compile branded iOS, Android, and web clients without
maintaining a private fork or editing application source.

### MVP outcomes

A user can:

- create an account and edit a profile;
- create, discover, follow, and unfollow public communities;
- publish, edit, and delete text or link posts;
- read threaded comments and add, edit, or delete comments;
- upvote, downvote, or clear a vote;
- browse home, local, community, and post-detail feeds;
- report content and block users;
- use the product on responsive web, iOS, and Android.

A moderator can:

- edit community metadata and rules;
- appoint or remove moderators;
- remove or restore content;
- lock a post;
- ban or unban a user from a community;
- review reports and an immutable moderation log.

An instance administrator can:

- deploy a complete instance from documented release artifacts;
- set the instance identity, policy, branding, email, storage, and public origin
  through validated configuration;
- configure registration and media limits;
- allow, limit, or block remote domains;
- inspect federation queues and failures;
- suspend local users and remove local content;
- upgrade through supported database and configuration migrations;
- compile a single-instance React Native app from a branding/build profile;
- expose basic health, metrics, and NodeInfo.

### MVP federation contract

Feddit will initially interoperate with Lemmy-compatible group federation and
gracefully expose public objects to generic ActivityPub consumers such as
Mastodon. The guaranteed activity/object surface is:

- actors: `Person`, `Group`;
- objects: `Page`, `Note`, `Tombstone`;
- activities: `Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`,
  `Announce`, `Like`, `Dislike`, `Undo`;
- discovery and collections: WebFinger, actor documents, inbox/shared inbox,
  outbox, followers, following, and NodeInfo.

Receiving aliases such as `Article` for posts may be supported when safely
normalizable, but Feddit emits the documented canonical types.

### Explicit non-goals for MVP

- private, restricted, or paid communities;
- direct messages, polls, live chat, stories, and native video transcoding;
- follower-only posts or end-to-end encryption;
- offline creation or conflict resolution;
- GraphQL, third-party plugins, or a public write SDK;
- multi-domain tenancy within one Feddit deployment (self-hosters run one
  deployment per canonical instance origin);
- Kubernetes, database replicas, or external search engines;
- perfect behavioral parity with every Fediverse implementation.

## 3. Architecture principles

1. **One domain model, multiple adapters.** HTTP and ActivityPub translate into
   the same application commands. Domain services do not import Fedify or Hono.
2. **Stable public identity.** Published actor and object URLs never depend on
   database sequence values that may be rewritten or on a mutable username.
3. **Local authority is explicit.** Every actor and object records whether it is
   local or remote and which origin is authoritative.
4. **At-least-once delivery, idempotent effects.** Activity IDs, domain commands,
   jobs, and deliveries have uniqueness keys and can be retried safely.
5. **Moderation precedes reach.** Remote content is not indexed or fanned out
   until signature, origin, audience, authorization, and domain-policy checks
   succeed.
6. **Start operable, then scale.** The MVP uses the fewest stateful dependencies
   consistent with safe federation.
7. **Distribution is part of the product.** Configuration, installation,
   upgrades, backups, release artifacts, and downstream app builds are tested
   interfaces, not repository-specific knowledge.
8. **No mandatory vendor control plane.** A self-hoster can run the server and
   build clients using local tooling and commodity PostgreSQL, Redis, SMTP, and
   S3-compatible services. Hosted build and observability services remain
   optional.
9. **Tale UI is the UI foundation.** Feddit composes product UI from Tale UI's
   React Native components through a narrow Feddit-owned facade. It does not
   create a competing general-purpose component library.
10. **Progress is measured by observable user, operator, and protocol outcomes.**

## 4. Chosen technology stack

### Repository and runtime

- pnpm workspaces with Turborepo;
- TypeScript in strict mode;
- Node.js 24 LTS;
- Hono for the HTTP server;
- Fedify with its Hono integration for ActivityPub;
- Zod with `@hono/zod-openapi` for runtime validation and OpenAPI generation;
- Vitest for unit and integration tests.

### Data and asynchronous work

- PostgreSQL as the system of record;
- Drizzle ORM and checked-in SQL migrations;
- Redis for Fedify's production KV/message queue, rate-limit counters, short-lived
  cache entries, and BullMQ application jobs;
- a transactional PostgreSQL outbox between committed domain changes and
  asynchronous publication;
- S3-compatible object storage for media, with MinIO in local development;
- PostgreSQL full-text search and `pg_trgm` for MVP discovery.

Redis is not a source of truth. A lost cache can be rebuilt, and every job handler
must be idempotent.

### Client

- Expo and React Native;
- Expo Router for typed universal routes, deep links, and web rendering;
- React Native Web;
- Tale UI's React Native package as the primary component, accessibility, token,
  and theming foundation;
- TanStack Query for server state and optimistic updates;
- React Hook Form plus shared schema validation for forms;
- `packages/ui` as a thin Feddit facade over Tale UI plus Feddit-specific
  compositions;
- local component state by default; Zustand only if cross-screen ephemeral state
  proves necessary.

Because the Tale UI React Native package is currently under development, its
exact package name and first supported version are pinned by the Phase 0
readiness gate. The architectural commitment to Tale UI is fixed; prerelease API
churn is contained within `packages/ui`. Before a stable package exists,
development uses a reproducible versioned prerelease artifact or exact source
revision—never an unpinned branch—and records it in the lockfile.

### Delivery and quality

- Docker images for the API and worker;
- Docker Compose for local development and the reference single-node deployment;
- local Expo prebuild/Xcode/Gradle workflows for downstream native builds, with
  EAS Build supported only as an optional convenience;
- OpenTelemetry-compatible tracing, structured JSON logs, Prometheus metrics,
  and error reporting;
- Playwright for browser journeys and accessibility checks;
- Maestro for critical iOS/Android journeys;
- Testcontainers for PostgreSQL/Redis integration tests.

All dependency versions are pinned through the lockfile and upgraded
deliberately. The plan names product lines, not floating package versions.

## 5. System shape

```text
Expo app (web/iOS/Android) ── REST /api/v1 ─┐
                                            │
Remote ActivityPub servers ─ inbox/outbox ──┤
                                            ▼
                                  Hono API process
                              ┌────────┴────────┐
                              │ application core│
                              └───────┬─────────┘
                                      │ transaction
                           PostgreSQL + domain outbox
                                      │
                                      ▼
                              background worker
                         ┌────────────┼────────────┐
                         │            │            │
                  Fedify/Redis     search       media/S3
                    delivery      projection    processing
```

The initial deployment has two stateless application roles:

- **API:** client API, public object routes, WebFinger, NodeInfo, inbox receipt,
  authentication, and health endpoints;
- **worker:** domain-outbox relay, Fedify queue consumption, remote fetches,
  notifications, search projections, and media jobs.

They may run from one codebase and image with different entry points. Each
deployment represents one Feddit instance and one canonical public origin.

## 6. Repository structure

```text
apps/
  api/                    # Hono composition root and HTTP entry point
  worker/                 # asynchronous process entry point
  app/                    # Expo Router app for web, iOS, and Android
app-profiles/
  example.json            # non-secret downstream branding/build profile
packages/
  domain/                 # entities, policies, commands, events; no framework imports
  database/               # Drizzle schema, repositories, migrations, outbox
  federation/             # Fedify actors, dispatchers, mappers, inbox handlers
  api-contract/           # schemas, OpenAPI document, generated typed client
  jobs/                   # job definitions and idempotent handlers
  ui/                     # Feddit facade/compositions over Tale UI React Native
  product-config/         # instance and downstream app-profile schemas
  tooling-config/         # shared TypeScript, lint, test, and build config
infra/
  compose/
  docker/
  release/                # packaging, checksums, SBOM, and signing automation
docs/
  adr/
  federation/
  operations/
  self-hosting/
  app-builds/
```

Package import rules are enforced in lint/CI:

- `domain` imports no app, database, HTTP, queue, or federation package;
- `database` implements interfaces owned by `domain`;
- `federation` maps protocol types to application commands and domain events to
  protocol activities;
- `api` is a composition root, not a home for business logic;
- `app` consumes only the generated API client and `packages/ui`;
- direct Tale UI imports are confined to `packages/ui`, so upstream prerelease
  changes cannot spread across screens.

## 7. Domain and persistence model

Use UUIDv7 identifiers internally. Public ActivityPub IDs are HTTPS URLs derived
from immutable public IDs, not usernames.

### Principal records

- `actor`
  - kind (`person`, `group`), locality, immutable public ID, canonical AP URI,
    preferred username, display fields, inbox, shared inbox, public keys, remote
    origin, discovery timestamps, suspension state;
- `local_account`
  - actor ID, normalized email, password/OIDC credentials, verification and
    session state;
- `community`
  - Group actor ID, slug, title, description, rules, visibility, posting policy,
    NSFW flag, moderation settings;
- `community_membership`
  - community, actor, role (`follower`, `moderator`, `owner`), state, timestamps;
- `follow`
  - follower/followee actors, direction, state, canonical activity IDs;
- `post`
  - canonical URI, local/remote authority, author, community, title, body source,
    rendered safe HTML, link, NSFW/locked/removed state, timestamps;
- `comment`
  - canonical URI, author, community, post, parent comment, body source, rendered
    safe HTML, path/depth, removed state, timestamps;
- `vote`
  - voter actor, target, value (`1` or `-1`), canonical activity ID, timestamps,
    with one current vote per voter and target;
- `media`
  - owner, object key, checksum, MIME type, dimensions, scan/processing state,
    alt text;
- `report`, `community_ban`, `user_block`, `moderation_action`;
- `activity_receipt`
  - canonical activity ID, actor, type, digest, processing state, timestamps;
- `domain_event_outbox`
  - event ID/type/version, aggregate, payload, attempts, publication state;
- `delivery_attempt`
  - activity ID, destination inbox/domain, state, attempts, next attempt, error.

Remote payloads are retained in a bounded diagnostic form, but normalized tables
drive the product. Raw documents are never rendered directly.

### Important invariants

- Canonical AP URI is globally unique.
- Incoming activity ID is unique; a reused ID with a different digest is rejected
  and audited.
- A remote actor may mutate only objects for which authorization can be proven.
- A post belongs to exactly one community; a comment belongs to one post and the
  same community.
- Comment depth is capped and cycles are impossible.
- One active vote exists per actor and target.
- Domain state and its outbox event commit in one database transaction.
- Deletes create tombstones; published canonical IDs are not reused.
- User-facing counts are projections and can be rebuilt.

## 8. Federation design

### Outbound flow

1. The client API authenticates and authorizes an application command.
2. The domain change and versioned domain event commit together.
3. The worker claims the outbox event and maps it to an ActivityStreams activity.
4. Fedify signs and enqueues deliveries.
5. Deliveries are retried with bounded exponential backoff and per-domain
   concurrency/rate limits.
6. Permanent failures are visible to operators and can be replayed.

For community content, the author addresses the activity to the Group. The local
community validates it and emits an `Announce` to followers. Feddit must avoid
double-applying an object seen both directly and inside an `Announce`.

### Inbound flow

1. Apply request size, content type, IP/domain, and rate-limit checks.
2. Verify the HTTP signature and safely resolve/cache the actor document.
3. Reject private-network fetches, unsafe redirects, unsupported schemes, and
   payloads beyond configured limits.
4. Persist an activity receipt before acknowledging accepted work.
5. Process asynchronously and idempotently.
6. Validate actor authority, audience/community, object ownership, and local
   moderation/federation policy.
7. Normalize supported content, sanitize HTML, execute an application command,
   and emit any required community relay.
8. Quarantine or audit unsupported and suspicious activities without repeatedly
   retrying permanent failures.

### Interoperability fixtures

Maintain sanitized JSON fixtures and contract tests for:

- Person and Group discovery;
- remote Follow/Accept/Reject;
- Create/Update/Delete Page;
- Create/Update/Delete Note, including nested replies;
- Group Announce and duplicate delivery;
- Like, Dislike, and Undo;
- actor key rotation;
- Tombstone and fetch-after-delete;
- malformed signatures, spoofed attribution, hostile URLs, and blocked domains.

The first live compatibility target is a supported Lemmy release. Mastodon is a
secondary target for actor/object visibility, following, replies where semantics
align, and graceful handling where they do not. Additional implementations are
added to a published compatibility matrix only after repeatable tests pass.

## 9. Client API and authentication

### API conventions

- JSON REST API under `/api/v1`;
- schema-first validation with one source generating OpenAPI and the typed client;
- opaque cursor pagination, stable sort keys, and bounded page sizes;
- RFC 9457-style problem responses with stable application error codes;
- idempotency keys for create/mutation requests that mobile clients may retry;
- ETags or version fields for conflicting edits;
- no ActivityPub JSON exposed as the client API model.

Initial resources:

```text
/auth/register  /auth/login  /auth/logout  /auth/refresh
/me             /users       /sessions     /site
/communities    /follows     /feeds
/posts          /comments    /votes
/reports        /moderation  /admin/federation
/media/uploads
```

Use nested routes only when they express scoping, such as
`/posts/:id/comments`; keep canonical resources addressable by their own IDs.

### Authentication

- local email/password accounts with Argon2id password hashing and email
  verification;
- short-lived access credentials and rotating, hashed refresh tokens;
- secure, HTTP-only, same-site cookies on web;
- platform secure storage for native refresh tokens;
- CSRF protection for cookie-authenticated mutations;
- session listing and revocation;
- OIDC is an extension seam, not an MVP dependency.

ActivityPub signatures authenticate server/actor activities; they are never used
as end-user client sessions.

## 10. Universal client and web strategy

### Routes and layouts

Expo Router owns the universal route model and deep links. Important routes are:

```text
/(tabs)/home
/(tabs)/local
/c/[community]
/post/[id]
/u/[actor]
/create
/settings
/mod/[community]
/admin
```

- phones use bottom tabs and stack navigation;
- tablets and desktop web use adaptive two- or three-pane layouts;
- post/comment permalinks have stable, shareable URLs;
- web uses semantic roles/elements, keyboard navigation, visible focus, and
  reduced-motion support;
- virtualization and collapsed branches keep deep threads usable.

### Rendering decision gate

Public community, post, and profile pages require indexable HTML and per-route
metadata. During Phase 0, build a representative dynamic post route and validate:

- request-time rendering and deployment support;
- hydration correctness with React Native Web;
- canonical/meta/OpenGraph output;
- authenticated client navigation;
- performance and accessibility.

Prefer Expo Router server rendering if it passes the spike and its pinned release
is supportable. If it does not, add a small web-only public rendering shell that
uses the same API contract and URLs, while the universal app remains the
authenticated experience. Do not force SEO-sensitive pages into a client-only
SPA.

### Tale UI integration and Feddit UI

Tale UI React Native supplies general-purpose primitives and controls. Feddit's
`packages/ui` provides a stable application-facing facade and product
compositions:

- re-export or minimally adapt the supported Tale UI primitives used by Feddit;
- map Tale UI tokens to Feddit semantic roles such as surface, accent, vote-up,
  vote-down, moderation, warning, and destructive;
- compose domain components such as `VoteControl`, `PostRow`, `CommentNode`,
  `CommunityHeader`, `ReportDialog`, and moderation queue rows;
- centralize platform-specific behavior and the limited web escape hatches;
- expose no backend or federation concerns.

The first required Tale UI surface is typography, layout, button, link, text
input, checkbox, switch, select, avatar, card, menu, dialog/sheet, toast, badge,
tabs, and loading/empty states. Each component must be verified on iOS, Android,
and React Native Web for keyboard/focus behavior, screen-reader semantics,
reduced motion, contrast, responsive layout, Expo/Metro bundling, and Expo Router
rendering.

Feddit adopts Tale UI's base tokens and theme contract. Instance app profiles may
override a documented set of semantic brand tokens, but cannot inject arbitrary
code or bypass contrast requirements.

While Tale UI is prerelease, missing or unstable primitives may be implemented
temporarily behind the same `packages/ui` facade with React Native primitives.
Every temporary gap requires an owner, a Tale UI tracking issue, contract tests,
and a removal condition. These gap components cannot grow into a parallel
general-purpose design system.

Tale UI upgrades are deliberate: pin an exact compatible version, review its
changelog, run the UI compatibility suite, and record any facade changes.

### Downstream app builds

The same client source supports two distributions:

- the upstream Feddit app, using upstream defaults; and
- a self-hoster's single-instance app, preconfigured for that operator's server
  and branding.

A schema-validated, non-secret app profile supplies:

- API/instance origin and universal-link domains;
- display name, slug, URL scheme, iOS bundle ID, and Android application ID;
- icons, splash assets, supported Tale UI semantic theme overrides, and default
  locale;
- support, privacy, terms, and account-deletion URLs;
- optional analytics and push-provider identifiers.

Signing certificates, store credentials, push private keys, and service secrets
must never be stored in the profile or generated client bundle. A documented
command validates the profile, generates Expo/native configuration, verifies
required assets and server association files, and then invokes a local web,
iOS, or Android build. Building locally must not require an Expo account or
Feddit-operated service.

At runtime the app fetches `/api/v1/site` and verifies that the server's canonical
origin and capability declaration match the embedded profile. Mutable instance
metadata comes from this endpoint; security-sensitive build identity remains
compile-time configuration. App-profile schema changes are versioned and ship
with migrations.

## 11. Security, safety, and moderation

The threat model includes hostile remote servers, forged attribution, SSRF,
replay, activity floods, HTML/script injection, decompression bombs, media abuse,
credential theft, and moderator misuse.

Required controls:

- Fedify signature/integrity facilities with documented key rotation;
- strict outbound fetch policy and DNS/IP revalidation;
- activity/object byte limits, timeouts, redirect limits, and depth limits;
- sanitization with a minimal HTML allowlist and safe link attributes;
- MIME sniffing, checksum/deduplication, image pixel limits, malware scanning,
  and metadata stripping;
- layered rate limits by IP, account, actor, domain, and action;
- deny, limit, and allow modes for remote domains;
- immutable moderation audit records with reason and actor;
- secrets outside the database/repository and encrypted backups;
- log redaction for tokens, cookies, private keys, email addresses, and raw
  sensitive payloads;
- dependency, container, and migration scanning in CI.

Private/restricted content is deferred because ActivityPub audience handling does
not by itself provide confidentiality.

## 12. Open-source distribution and self-hosting

Open sourcing is a fixed product requirement, not a later architecture option.
The exact license and governance model are selected in Phase 0, before accepting
external contributions, and the repository is kept publication-ready from the
first commit. The license must be OSI-approved, permit independent hosting and
client compilation, and address network-hosted modifications intentionally.
Server and client licensing may differ if needed for app-store distribution, but
both remain open source.

Tale UI's React Native package must be available to downstream builders from a
public source or package registry under a redistribution-compatible license
before Feddit's public release. Feddit releases cannot depend on private registry
credentials, unpublished workspace state, or a paid Tale UI build service.

### Configuration and portability

- One versioned, schema-validated instance configuration surface covers canonical
  origin, instance metadata, registration policy, limits, federation policy,
  SMTP, storage, Redis, database, observability, and optional push delivery.
- Environment variables or mounted secret files provide secrets; configuration
  examples contain safe placeholders only.
- The canonical origin is immutable after federation begins unless an explicit,
  separately designed migration tool exists.
- Branding and policy do not require source changes.
- PostgreSQL, Redis, S3-compatible storage, and standard SMTP are the portable
  baseline; managed products are replaceable implementations.
- Telemetry and crash reporting are disabled by default unless an operator opts
  in and configures a destination.
- There is no license server, required callback to a Feddit-operated service, or
  hidden feature gate in self-hosted builds.

### Release and upgrade contract

Each stable release provides:

- a source tag/archive and changelog;
- versioned multi-architecture OCI images for API and worker;
- a pinned reference Compose file and configuration example;
- database and configuration migrations with supported upgrade paths;
- generated OpenAPI and federation-compatibility documentation;
- checksums, a software bill of materials, vulnerability scan results, and signed
  provenance for published artifacts;
- operator installation, upgrade, rollback, backup/restore, and troubleshooting
  guides;
- app-profile schema, example assets, and local web/iOS/Android build guide.

Feddit uses semantic versioning for its supported public surfaces. Deprecations
are announced before removal. A release is not complete until CI deploys the
previous stable version, upgrades it with retained data, and validates both the
server and a downstream app profile.

### Community readiness

Before the repository becomes public it includes `LICENSE`, `README`,
`CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, support boundaries, an issue
template, an architectural overview, and a disclosure process. Tests cannot
depend on private infrastructure. Example data, fixtures, commits, build logs,
and repository history are checked for credentials and personal information.

## 13. Operability and deployment

### Reference deployment

Docker Compose runs:

- API;
- worker;
- PostgreSQL;
- Redis;
- MinIO (development/self-hosted option);
- a reverse proxy terminating HTTPS.

Production operators may use managed PostgreSQL, Redis, and S3. Kubernetes
manifests are added only when a real deployment needs orchestration.

### Health and telemetry

- `/health/live` checks process liveness only;
- `/health/ready` checks required database/queue dependencies;
- metrics cover HTTP latency/errors, inbox receipt/processing, queue depth,
  delivery latency/outcomes by remote domain, job retries/dead letters, database
  pool pressure, media failures, and moderation volume;
- traces carry an activity/event correlation ID across inbox, domain command,
  outbox, and delivery;
- dashboards and alerts are versioned alongside the app.

Initial service objectives for the private beta:

- 99.5% monthly API availability, excluding planned maintenance;
- 95% of accepted inbox activities processed within 60 seconds;
- 95% of healthy-destination outbound deliveries attempted within 60 seconds;
- no acknowledged domain event lost after a single process restart.

Backups and restore drills are release gates, not operator-documentation
afterthoughts.

## 14. Delivery roadmap

Time ranges are planning estimates for a small experienced team and should be
re-estimated after Phase 0.

### Phase 0 — Decisions and risk spikes (1–2 weeks)

Deliver:

- repository scaffold, CI, formatting, type checking, test harnesses;
- license/governance ADR and a publication-readiness checklist;
- ADRs for canonical URLs, post/community federation, authentication, HTML
  sanitization, and web rendering;
- Tale UI React Native readiness spike and integration ADR covering its package
  identity, license, versioning, Expo/Metro and React Native Web compatibility,
  accessibility, theming, rendering, and missing-component inventory;
- versioned instance-configuration and app-profile schemas with example files;
- database/Redis/MinIO local environment;
- a throwaway but tested Fedify ↔ Lemmy exchange for Group follow, Page create,
  Announce, Note reply, Like, Dislike, and Undo;
- dynamic Expo web route rendering spike;
- a locally compiled, rebranded web and native client proof using only an app
  profile and external signing credentials;
- initial threat model and compatibility matrix.

Exit gate:

- captured signed payloads round-trip with Lemmy;
- the team can state the canonical ID and authority rules without open ambiguity;
- one web rendering approach meets the public-route requirements;
- the pinned Tale UI build renders a representative feed, form, dialog, and
  threaded comment on iOS, Android, and web through `packages/ui`, with every
  missing primitive assigned a bounded gap plan;
- a clean checkout can build an operator-branded client without source edits or
  a mandatory hosted build service.

### Phase 1 — Production-shaped federation spine (3–5 weeks)

Deliver:

- core schema and migrations;
- local Person and Group actor documents, keys, WebFinger, NodeInfo, inbox,
  shared inbox, outbox, followers, and following;
- transactional domain outbox, Fedify Redis queue, retries, receipts, and
  idempotency;
- Create/Update/Delete for Page and Note;
- Follow/Accept/Reject, Announce, Like/Dislike/Undo;
- signature, SSRF, size, sanitization, and domain-policy controls;
- schema-validated instance configuration and `/api/v1/site` capabilities;
- federation fixtures, admin queue inspection, metrics, and structured logs.

Exit gate:

- two clean Feddit instances and the supported Lemmy target exchange the contract
  activities through restart and duplicate-delivery tests;
- unauthorized updates, replay variants, and hostile fetch targets are rejected.

### Phase 2 — End-to-end product MVP (5–8 weeks)

Deliver vertical slices in this order:

1. account registration/login/session management and profile;
2. community create/discover/follow plus rules and roles;
3. text/link post create/read/edit/delete and feeds;
4. threaded comment create/read/edit/delete;
5. vote/clear vote with optimistic UI and reconciled counts;
6. report/block/remove/restore/lock/ban workflows and audit log;
7. image upload/processing and alt text;
8. PostgreSQL search and notifications;
9. downstream app-profile validation and branded web/iOS/Android build workflow.

Each slice includes domain rules, migration, API/OpenAPI, federation mapping,
Tale UI-based responsive UI, accessibility, telemetry, and automated tests.

Exit gate:

- every MVP user and moderator outcome works on responsive web;
- critical journeys pass on one supported iOS and Android version;
- local and federated state converge after retry, duplication, and reordering
  scenarios.

### Phase 3 — Private beta hardening (3–5 weeks)

Deliver:

- load and abuse testing;
- queue backpressure, dead-letter/replay tooling, and per-domain circuit breakers;
- migration rollback/forward testing;
- backup restoration and actor-key recovery drills;
- moderation and admin usability pass;
- Tale UI compatibility, accessibility, visual-regression, and performance
  audits against the release-pinned version;
- release artifacts, SBOM/provenance, and clean-machine installation tests;
- operator guide, security policy, data retention policy, and upgrade guide;
- public-repository readiness audit and credential/history scan.

Exit gate:

- service objectives hold under the agreed beta load;
- restore and rollback drills pass;
- a tester who did not develop Feddit can install an instance, upgrade retained
  data, and compile a branded app from the published documentation;
- no unresolved critical security or data-integrity findings remain.

### Phase 4 — Public web and mobile release

Deliver:

- production web deployment and app-store builds;
- publication of the server and client source under the selected open-source
  license no later than the first public release;
- signed server images, source archives, reference Compose deployment, and
  downstream app-build kit;
- privacy disclosures, account/data deletion, support process, and incident
  runbook;
- compatibility matrix published from CI-tested evidence;
- release automation, signed images, changelog, and versioned API/federation
  contract.

After launch, add external search, CDN/media variants, read replicas,
orchestration, polls, richer moderation, and additional Fediverse targets only in
response to measured needs and explicit ADRs.

## 15. Verification matrix

Every merge must run the checks relevant to the change:

| Layer | Required verification |
| --- | --- |
| Domain | unit/property tests for invariants and authorization |
| Database | migration from last release, repository integration, concurrent-write tests |
| API | schema validation, auth/CSRF, pagination, idempotency, generated-client compatibility |
| Federation | signed fixtures, duplicate/reorder/retry tests, authority and hostile-fetch cases |
| Worker | crash/restart, lease expiry, retry, dead-letter, and replay tests |
| Tale UI facade | component contracts, token/theme mapping, upstream-version compatibility, temporary-gap inventory |
| Web | Playwright critical journeys, keyboard/screen-reader semantics, metadata, responsive screenshots |
| Native | Maestro smoke journeys on iOS and Android |
| Distribution | clean-machine install, prior-version upgrade, config validation, source archive, SBOM/provenance |
| Downstream app | example-profile web/iOS/Android config generation, asset checks, local build smoke |
| Operations | image build, Compose boot, health checks, metrics, backup/restore smoke |

CI blocks merging on lint, formatting, type errors, migration drift, contract
drift, unit/integration failures, or high-severity dependency findings.

## 16. Decisions intentionally left reversible

These are decided by evidence at their named gates rather than chosen up front:

- Expo Router request-time rendering versus a small public web shell (Phase 0);
- exact Tale UI React Native package name and compatible version, resolved by the
  Phase 0 readiness gate without changing Tale UI's fixed role as the primary UI
  foundation;
- exact password/email providers and managed observability vendors;
- deployment platform beyond the reference Compose topology;
- when PostgreSQL search should be replaced;
- which additional Fediverse implementations enter the guaranteed matrix;
- exact OSI-approved license and governance model, which must be resolved in
  Phase 0 without changing the fixed open-source requirement.

Everything else in Sections 2–15 is the implementation baseline. A material
deviation needs an ADR that identifies the new evidence, migration impact, and
rollback plan.

## 17. Primary references

- W3C ActivityPub Recommendation:
  https://www.w3.org/TR/activitypub/
- W3C ActivityStreams 2.0 Core:
  https://www.w3.org/TR/activitystreams-core/
- W3C Activity Vocabulary:
  https://www.w3.org/TR/activitystreams-vocabulary/
- Fedify federation manual:
  https://fedify.dev/manual/federation
- Fedify framework integration manual:
  https://fedify.dev/manual/integration
- Fedify deployment manual:
  https://fedify.dev/manual/deploy
- Fedify NodeInfo manual:
  https://fedify.dev/manual/nodeinfo
- Lemmy federation behavior and payloads:
  https://join-lemmy.org/docs/en/contributors/05-federation.html
- Hono Zod/OpenAPI example:
  https://hono.dev/examples/zod-openapi
- Expo Router introduction:
  https://docs.expo.dev/router/introduction/
- Expo Router server rendering:
  https://docs.expo.dev/router/web/server-rendering/
- Node.js release status:
  https://nodejs.org/en/about/previous-releases
