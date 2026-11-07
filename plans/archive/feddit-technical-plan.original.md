# Archived Source Plan: Feddit Technical Architecture and Implementation Plan

> Historical input only. The canonical plan is `plans/feddit-plan.md`.

## 1. Vision and Goals

Feddit is a Reddit‑style, ActivityPub‑native platform for communities, posts, comments, and voting, designed to federate with Mastodon, Lemmy‑like instances, Pixelfed, Mbin, and other Fediverse software.[web:3][web:18][web:19][web:24] It aims to provide an app‑like cross‑platform experience (web, iOS, Android) using a single React Native codebase, similar to Bluesky’s `social-app`, while delegating most ActivityPub protocol plumbing to Fedify.[web:63][web:65][web:70][web:75][web:76]

Key goals:

- Full ActivityPub compliance, built on ActivityStreams 2.0 and JSON‑LD.
- Clean, modern UX distinct from Lemmy/Piefed/Mbin while retaining feature parity.
- A reusable, open‑source core that instances can deploy, customize, and extend.
- Single cross‑platform client using React Native + React Native Web.
- Strong moderation tooling, storage flexibility, and federation controls.

---

## 2. High‑Level Architecture

### 2.1 Logical Components

- **Federation & Protocol Layer (Fedify‑based)**
  - Handles ActivityPub, ActivityStreams, WebFinger, NodeInfo, HTTP/Linked Data Signatures, integrity proofs, and inbox/outbox plumbing.[web:31][web:6][web:33][web:75][web:79][web:83]
- **Domain & Application Layer (Feddit Core)**
  - Implements Feddit’s domain model: users, communities, posts, comments, votes, moderation logs, and configuration.
- **Persistence Layer**
  - PostgreSQL (primary relational store) plus optional search (ElasticSearch/OpenSearch) and caching (Redis).
- **Storage Layer**
  - Pluggable media storage (local disk, S3‑compatible object stores such as MinIO, Wasabi, Backblaze, or cloud provider buckets).[web:19][web:23][web:25][web:29]
- **Client API Layer**
  - REST/GraphQL API consumed by clients (React Native app, potential third‑party clients).
- **Cross‑Platform Client**
  - React Native + React Native Web app (Expo or bare RN) targeting Web, iOS, and Android, sharing UI primitives and design tokens.[web:51][web:60][web:63][web:65][web:70]

### 2.2 Runtime Choices

- **Backend runtime**: Node.js, Deno, or Bun, with a preference for Node.js/Deno due to Fedify’s explicit support.[web:79][web:81][web:85]
- **Web framework**: Fastify, Hono, or NestJS, with Fedify integration.
- **Deployment**: Containerized services (Docker/Kubernetes/Nomad) with separate pods/services for API, workers, and storage.

---

## 3. ActivityPub and Data Model

### 3.1 Core Specifications

Feddit’s federation follows:

- **ActivityPub** (W3C Recommendation): federation protocol, inbox/outbox, and delivery guarantees.[web:6][web:1]
- **ActivityStreams 2.0**: JSON‑LD data model and vocabulary for activities, actors, and objects.[web:31][web:32][web:43]
- **WebFinger (RFC 7033)**: discovery for `@user@feddit.com` and `@community@feddit.com` identifiers.[web:33][web:38][web:9]

### 3.2 Domain Entities → ActivityStreams Types

- **User**
  - Internal: `User` entity with username, profile, preferences.
  - ActivityStreams: `Person` actor with properties `id`, `preferredUsername`, `name`, `summary`, `inbox`, `outbox`, `followers`, `following`.
- **Community**
  - Internal: `Community` entity (similar to subreddit) with slug, title, description, rules, moderators.
  - ActivityStreams: `Group` actor; its `outbox` represents the community timeline (posts).[web:18][web:43]
- **Post**
  - Internal: `Post` with title, body, link metadata, attachments, community, author, score.
  - ActivityStreams: `Article` (or `Note`) with `attributedTo` (author), `context` (community), and attachments (`Image`, `Video`).[web:31][web:43]
- **Comment**
  - Internal: `Comment` with body, author, parent (post or comment), thread metadata.
  - ActivityStreams: `Note` with `inReplyTo` pointing to the parent object and `context` for thread grouping.[web:4][web:34][web:43]
- **Vote**
  - Internal: `Vote` with user, target (post/comment), direction (up/down), and timestamp.
  - ActivityStreams: map upvotes to `Like` and downvotes to an extension or represent both as `Like` + `Undo` (for removing votes), using FEP‑style extensions if needed.[web:18][web:24][web:43]
- **Moderation Action**
  - Internal: `ModerationAction` with actor (mod/admin), target, action type (remove, ban, lock, sticky), reason, timestamps.
  - ActivityStreams: use `Block`, `Reject`, `Delete`, `Tombstone` where appropriate; mod logs remain primarily internal.[web:34][web:43]

### 3.3 Identity and Discovery

- Provide `/.well-known/webfinger` endpoint returning JRD JSON for `acct:` URIs mapped to user/community actor URLs.[web:33][web:38][web:9]
- Ensure actor IDs and WebFinger subjects/links remain stable and consistent across instances to avoid federation issues.[web:3][web:9][web:13]

---

## 4. Backend Implementation with Fedify

### 4.1 Fedify Overview

Fedify is a TypeScript ActivityPub server framework that aims to eliminate boilerplate and complexity when building federated apps, providing type‑safe interfaces, WebFinger, HTTP/Linked Data Signatures, and federation infrastructure.[web:75][web:76][web:79][web:83][web:85][web:87]

Key Fedify capabilities:

- Typed ActivityPub/ActivityStreams objects (actors, notes, collections).
- WebFinger and NodeInfo handlers.
- HTTP Signatures, HTTP Message Signatures, Linked Data Signatures, Object Integrity Proofs.[web:78][web:79][web:83][web:87]
- Inbox/outbox routing, delivery fan‑out, deduplication, retries, SSRF protection.[web:78][web:80][web:83]
- Integration with popular web frameworks and runtimes (Node.js, Deno, Bun).[web:80][web:83][web:86]

### 4.2 Backend Project Structure

Example monorepo layout (TypeScript):

```text
feddit/
  packages/
    feddit-core/          # Domain logic and persistence
    feddit-fedify/        # Fedify integration and federation endpoints
    feddit-api/           # Client API (REST/GraphQL)
    feddit-workers/       # Background workers for federation, search, media
  services/
    api-service/          # Container for API + Fedify HTTP server
    worker-service/       # Worker containers
    media-service/        # Media processing service
  infra/
    k8s/                  # Kubernetes manifests
    docker/               # Dockerfiles and compose
```

### 4.3 Fedify Integration Steps

1. **Initialize Fedify server**
   - Choose runtime (Node.js/Deno) and web framework (Fastify/Hono).
   - Instantiate Fedify server, configure WebFinger, NodeInfo, and ActivityPub routes.[web:80][web:83][web:86]

2. **Define Feddit actor types**
   - Use Fedify’s type interfaces to model `Person` and `Group` actors for users and communities, with appropriate inbox/outbox URLs.

3. **Implement persistence hooks**
   - Connect Fedify’s actor and object operations to Feddit’s PostgreSQL persistence layer (via repositories or data access layer).

4. **Configure signatures and security**
   - Enable HTTP Signatures and Linked Data Signatures, configure keys per instance/actor.
   - Use Fedify’s SSRF protections and object integrity verification to guard incoming activities.[web:78][web:83][web:87]

5. **Activity handlers**
   - Implement handlers for `Create`, `Update`, `Delete`, `Follow`, `Like`, `Announce`, `Undo`, mapping them to Feddit’s domain actions (creating posts/comments, handling follows, votes, and re‑shares).[web:31][web:34][web:43]

6. **WebFinger and NodeInfo**
   - Implement Fedify WebFinger integration to produce JRD responses based on Feddit’s user/community data.[web:33][web:38][web:9]
   - Expose NodeInfo to describe instance capabilities.

### 4.4 Client API Layer

In addition to ActivityPub endpoints, provide a dedicated client API:

- **REST endpoints** (example):
  - `GET /api/v1/communities`
  - `POST /api/v1/communities`
  - `GET /api/v1/communities/:id/posts`
  - `POST /api/v1/posts`
  - `POST /api/v1/posts/:id/comments`
  - `POST /api/v1/posts/:id/votes`
  - `GET /api/v1/users/:id/feed`
  - `POST /api/v1/moderation/reports`

- **GraphQL alternative**:
  - Single endpoint exposing typed schemas for communities, posts, comments, votes, and moderation operations.

Version APIs (e.g., `/api/v1`, `/api/v2`) and keep them separate from Fedify’s ActivityPub endpoints to maintain a clean separation between federation and client consumption.

---

## 5. Storage, Search, and Infrastructure

### 5.1 Databases

- **Primary DB**: PostgreSQL for relational data (users, communities, posts, comments, votes, moderation logs).
- **Search**: ElasticSearch/OpenSearch for full‑text and faceted search across communities and content.
- **Caching**: Redis for session storage, rate‑limiting counters, and hot path caching.

### 5.2 Media Storage

- Use S3‑compatible object storage for images and video attachments, following patterns from Pixelfed’s docs (uploading, resizing, thumbnails).[web:19][web:23][web:25][web:29]
- Store metadata (dimensions, MIME type, checksum) in PostgreSQL for referential integrity.

### 5.3 Deployment and Scaling

- Containerize services (API, workers, media) and deploy via Kubernetes or similar.
- Use horizontal scaling for stateless API nodes.
- Use worker pools for federation ingestion/delivery, search indexing, and media tasks.
- Add PostgreSQL read replicas and partitioning strategies as instances grow.

---

## 6. Cross‑Platform Client: React Native + React Native Web

### 6.1 Approach

Feddit adopts a Bluesky‑style architecture: a single React Native app targeting Web, iOS, and Android via React Native Web and Expo.[web:63][web:65][web:70][web:74][web:51][web:60]

Goals:

- Maximize UI and logic reuse across all platforms.
- Provide an app‑like experience in the browser.
- Maintain accessibility and reasonable web ergonomics.

### 6.2 Client Monorepo Structure

```text
feddit/
  apps/
    feddit-app/         # Expo/React Native app (web, iOS, Android)
  packages/
    ui/                 # Cross-platform RN components (using react-native-web)
    design-tokens/      # Theme, spacing, typography tokens
    api-client/         # TypeScript API client (REST/GraphQL + ActivityPub helpers)
```

### 6.3 React Native and React Native Web

- **React Native** provides the base component primitives (`View`, `Text`, `Pressable`, etc.).
- **React Native Web** maps these primitives to accessible HTML elements and CSS in the browser, enabling near‑100% component reuse for app‑like web experiences.[web:51][web:55][web:60]
- **Expo** manages builds, development, and deployment across all targets.[web:47][web:67][web:70]

### 6.4 UX and Screens

Key screens:

- Home feed (subscribed communities + global feeds).
- Community view (posts list, sidebar/community info, rules).
- Post detail (threaded comments, voting, moderation controls).
- User profile (posts, comments, communities, settings).
- Moderation dashboard (queues, filters, bulk actions).

Implement navigation using React Navigation (stack and tab navigators) with platform‑adaptive behavior (e.g., multi‑pane on large web screens, bottom tabs on mobile).

### 6.5 Accessibility and Web Considerations

- Leverage React Native Web’s accessible implementation and ensure semantic mapping for screen readers.[web:51][web:60]
- Use design tokens to keep contrast and spacing consistent across platforms.
- Consider server‑side rendering or pre‑rendering for initial web load where SEO is important.

---

## 7. Moderation, Community Management, and Federation Controls

### 7.1 Moderation Feature Set

Inspired by Lemmy, Mastodon, and Pixelfed:[web:18][web:22][web:24][web:3][web:19][web:29]

- Per‑community moderators with granular permissions.
- Instance‑level admins with tools for:
  - Domain‑level defederation (block or limit remote instances).[web:22][web:30]
  - IP/user bans.
  - Global content removals and policy enforcement.
- Reporting and abuse handling queues.
- Persistent audit logs of moderation actions.

### 7.2 Federation Controls

- Allowlist and denylist per remote domain (similar to Lemmy’s allowlist federation).[web:22][web:30]
- Rate limits and sandboxing for new or suspicious instances.
- Configurable policies per community (e.g., which remote instances may participate).

---

## 8. Security and Privacy

### 8.1 Protocol‑Level Security

- Use HTTP Signatures and Linked Data Signatures to authenticate actors and verify integrity of activities.[web:78][web:79][web:83][web:87]
- Support HTTP Message Signatures (RFC 9421) where appropriate.[web:78][web:83]
- Leverage Fedify’s SSRF protection and integrity checks.

### 8.2 Application Security

- Strict validation and sanitization of input.
- Role‑based access control for moderation and admin actions.
- Rate limiting and abuse protection at API layer.

### 8.3 Privacy and Audience Targeting

- Use ActivityStreams collections and audience fields (`to`, `cc`, `bto`, `bcc`) to represent public vs restricted posts.[web:34][web:43]
- Provide clear user controls over visibility (public, followers‑only, community‑only).

---

## 9. Development Workflow and Tooling

### 9.1 Backend Workflow

- TypeScript for Feddit core and Fedify integration.
- Testing stack: Jest/Vitest for unit tests; integration tests against Mastodon/Lemmy/Pixelfed using local test instances.[web:3][web:18][web:19][web:24]
- Continuous integration: linting (ESLint), type checking (tsc), unit/integration tests.

### 9.2 Frontend Workflow

- Expo for unified development across web, iOS, Android.[web:47][web:67][web:70]
- Storybook or similar tooling for cross‑platform component development.
- E2E tests with Detox (mobile) and Playwright (web).

### 9.3 Observability

- Centralized logging (structured JSON logs from backend and workers).
- Monitoring and metrics (Prometheus + Grafana, or hosted alternatives).
- Tracing (OpenTelemetry) for federation flows and API performance.

---

## 10. Roadmap and Milestones

### Phase 1: Protocol and Minimal Client

- Implement Fedify integration: actors, WebFinger, inbox/outbox, basic activities (`Create`, `Follow`, `Like`).[web:75][web:79][web:80]
- Design Feddit schema (users, communities, posts, comments, votes).
- Build minimal React Native client (home feed, community view, post detail) and deploy to web via RN Web.

### Phase 2: Feature Parity and Moderation

- Add voting, threading, and community management.
- Implement moderation tools and federation controls (allowlist/denylist, reporting). [web:18][web:22][web:24][web:30]
- Harden security: signatures, SSRF protection, rate limiting.

### Phase 3: Performance, UX, and Ecosystem

- Optimize performance and scalability (workers, search, caching).
- Polish UX across platforms (responsive layouts, accessibility).
- Open‑source Feddit core, publish documentation and API references.
- Engage with SocialHub and Fediverse projects for interoperability testing and FEP‑style extension proposals.[web:10][web:22][web:27][web:83]

---

## 11. Open Source and Governance

- License Feddit under AGPL‑3.0 or a permissive license (Apache/MIT) depending on desired ecosystem; consider alignment with Mastodon/Pixelfed practices.[web:19][web:29][web:45]
- Maintain clear contribution guidelines and a roadmap.
- Provide comprehensive docs:
  - Architecture and protocol mapping.
  - Backend/API reference.
  - Client development guide.
  - Deployment and scaling guides.

This document serves as the foundational technical plan for implementing Feddit using Fedify and a Bluesky‑style React Native + React Native Web client architecture.
