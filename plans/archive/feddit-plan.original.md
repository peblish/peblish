# Archived Source Plan: Feddit Technical Design and Implementation Plan

> Historical input only. The canonical plan is `plans/feddit-plan.md`.

## 1. Introduction

Feddit is a federated, Reddit-like content aggregation and discussion platform built on ActivityPub, targeting web, iOS, and Android from a single React Native codebase.

This document describes the technical architecture and implementation plan for Feddit, assuming:

- A TypeScript backend using Fedify as the ActivityPub/federation layer.
- React Native as the primary UI framework, with React Native Web for the browser client ("app-like" web experience similar to Bluesky).
- PostgreSQL + Redis + an object storage backend (S3-compatible) as core infrastructure.

References:

- ActivityPub specification: https://www.w3.org/TR/activitypub/
- ActivityStreams 2.0: https://www.w3.org/TR/activitystreams-core/
- Fedify framework: https://fedify.dev/
- Bluesky social app (React Native for web + mobile): https://github.com/bluesky-social/social-app

---

## 2. High-Level System Overview

### 2.1 Core Components

Feddit consists of the following major components:

- **Backend API & Federation Service**
  - HTTP API for Feddit clients (web/mobile).
  - Domain logic for users, communities, posts, comments, votes, moderation.
  - Fedify-based federation engine (ActivityPub actors, inbox/outbox, WebFinger, signatures).

- **Cross-Platform Client (React Native)**
  - Single React Native app targeting:
    - iOS (React Native / Expo or bare RN).
    - Android.
    - Web via React Native Web (RNW).
  - Feddit-specific design system built on top of React Native primitives.

- **Infrastructure Services**
  - PostgreSQL for relational data.
  - Redis for caching, queues, rate limiting.
  - Object storage (e.g., S3, MinIO, Wasabi) for media and attachments.
  - Background worker processes for federation, notifications, search indexing, media processing.

### 2.2 Monorepo Structure

Use a monorepo (e.g., pnpm workspaces or Turborepo) to share code:

- `apps/backend` – HTTP API + Fedify integration.
- `apps/feddit-app` – React Native application (Expo recommended).
- `packages/shared` – shared TypeScript models, validators, API client, utility functions.
- `packages/design-system` – cross-platform design system built on React Native primitives.
- `packages/config` – ESLint, TypeScript, Babel, Metro config shared across apps.

---

## 3. Technology Stack

### 3.1 Backend

- **Language**: TypeScript.
- **Runtime**: Node.js (or Deno/Bun if preferred and compatible with Fedify).
- **HTTP Framework**: Hono, Fastify, or Express (Hono recommended for Deno/Bun compatibility).
- **Federation Layer**: Fedify (TS ActivityPub framework).
- **Database**: PostgreSQL.
- **ORM/Query Layer**: Prisma or Drizzle.
- **Cache/Queue**: Redis (BullMQ or custom queue abstraction).
- **Search**: Meilisearch or OpenSearch.

### 3.2 Frontend (Cross-Platform)

- **React Native** for iOS, Android, and Web.
- **React Native Web** (RNW) to render RN components in the browser.
- **Navigation**: React Navigation (native) + platform-specific routing for web.
- **State/Data**: React Query / TanStack Query, Zustand or Redux as needed.
- **Styling**: Design system components with theme tokens, using `StyleSheet` or `styled-components` for RN.

### 3.3 Infrastructure & DevOps

- Containerization: Docker.
- Orchestration: Kubernetes or Nomad (for multi-instance deployments).
- CI/CD: GitHub Actions, GitLab CI, or a custom pipeline.
- Observability: Prometheus + Grafana, OpenTelemetry tracing, structured logging.

---

## 4. ActivityPub & Fedify Integration

### 4.1 Role of Fedify

Fedify provides:

- Type-safe ActivityStreams vocabulary classes (actors, activities, objects).
- WebFinger client/server utilities.
- HTTP Signatures and object integrity proof implementations.
- Inbox/outbox handling with message queue abstraction and retry policies.
- Interoperability tweaks for Mastodon and other Fediverse software.

Feddit uses Fedify strictly as the "federation engine"; all domain logic remains in Feddit’s own services.

### 4.2 Backend Integration Pattern

At a high level:

1. Initialize Fedify within the backend application, providing:
   - Host configuration (domain(s), HTTPS settings).
   - Storage backends for queued activities (Redis or DB).
   - Key management for actor public/private keys.

2. Define Fedify actors representing Feddit entities:
   - `Person` – Feddit user accounts.
   - `Group` – Feddit communities (subreddits equivalent).

3. Map Feddit domain operations to ActivityPub activities:
   - `Create` for new posts and comments.
   - `Like` / `Undo` for votes.
   - `Follow` / `Accept` / `Reject` for user and community follows.
   - `Announce` for boosts / reshares.

4. Configure Fedify inbox listeners to:
   - Validate incoming activities (signatures, integrity).
   - Map them into Feddit domain commands (e.g., create remote post, record follow).
   - Queue heavy work (e.g., fan-out, full text indexing) into background workers.

5. Configure Fedify outbox senders to:
   - Serialize outgoing activities.
   - Sign HTTP requests.
   - Handle retries and backoff for unreachable remote instances.

### 4.3 Separation of Concerns

Create a dedicated module/service for federation:

- `apps/backend/src/federation/` contains:
  - Fedify initialization.
  - Actor factories (map Feddit domain models to ActivityPub actors).
  - Activity producers (convert domain events to ActivityPub activities).
  - Inbox listeners (convert ActivityPub activities to domain commands).

- Domain services (`apps/backend/src/domain/`) remain unaware of ActivityPub; they operate purely on Feddit’s internal models. Federation code subscribes to domain events and publishes/consumes activities accordingly.

---

## 5. Domain Model

### 5.1 Core Entities

- **User**
  - id, username, displayName, bio.
  - email (local login), auth provider data.
  - profile settings (theme, content preferences, NSFW flags).

- **Community**
  - id, slug, title, description.
  - rules, flairs, visibility (public/private/restricted).
  - owner, moderators.

- **Post**
  - id, authorId, communityId.
  - type (`text`, `link`, `image`, `video`, `poll`).
  - title, body, URL, media attachments.
  - createdAt, updatedAt.

- **Comment**
  - id, postId, authorId.
  - parentCommentId (for nesting), body.
  - createdAt, updatedAt.

- **Vote**
  - id, userId, targetType (`post` or `comment`), targetId.
  - value (`+1` or `-1`).

- **Moderation**
  - Ban/timeout records.
  - Reports.
  - Mod actions (remove, lock, flair, sticky, etc.).

### 5.2 ActivityPub Mapping

- User → `Person`.
- Community → `Group` (with community rules encoded as metadata).
- Post → `Note` or `Article` depending on length/format.
- Comment → `Note` with `inReplyTo` referencing post/comment.
- Vote → `Like` or custom extension mapped to `Like` + metadata.
- Follow community → `Follow` activity directed at `Group` actor.

The mapping is implemented in federation adapter functions; domain services only operate on Feddit’s relational models.

---

## 6. API Design

### 6.1 HTTP API

Expose a versioned JSON API for clients:

- Base path: `/api/v1`.

#### Example endpoints

- Auth: `POST /api/v1/auth/login`, `POST /api/v1/auth/register`.
- Users: `GET /api/v1/users/:id`, `GET /api/v1/me`, `PATCH /api/v1/me`.
- Communities: `GET /api/v1/communities`, `POST /api/v1/communities`, `GET /api/v1/communities/:slug`.
- Posts: `GET /api/v1/posts`, `POST /api/v1/posts`, `GET /api/v1/posts/:id`.
- Comments: `GET /api/v1/posts/:id/comments`, `POST /api/v1/posts/:id/comments`.
- Votes: `POST /api/v1/posts/:id/vote`, `POST /api/v1/comments/:id/vote`.
- Moderation: `GET /api/v1/mod/reports`, `POST /api/v1/mod/posts/:id/remove`, etc.

### 6.2 Extensibility

- Use OpenAPI/Swagger or Zod schemas for request/response validation.
- Reserve extension fields on resources (e.g., `metadata` objects) for per-instance customization.
- Provide webhooks or plugin hooks when major events occur (post created, mod action, federation event).

---

## 7. React Native Cross-Platform App

### 7.1 Goals

- **Single codebase** for iOS, Android, and web.
- **Consistent app-like UX** across platforms, similar to Bluesky’s approach.
- **Design system-driven UI** using Feddit-specific components built on React Native primitives.

### 7.2 App Architecture

- Entry point: `apps/feddit-app/src/index.tsx` (platform-specific entry files as needed).
- Use React Navigation for stack, tab, and drawer navigation.
- Organize screens by feature:
  - `screens/HomeFeed` – global & personalized feed.
  - `screens/Community` – community info, posts, rules.
  - `screens/Post` – post details, comments.
  - `screens/CreatePost` / `CreateComment`.
  - `screens/Profile`, `screens/Settings`.
  - `screens/Moderation` – mod dashboards.

### 7.3 Web Support (React Native Web)

- Use React Native Web to render RN components in the browser.
- Configure Webpack/Metro via Expo or custom setup to support RNW.
- Implement web routing using `@react-navigation/native` with `Linking` configuration, or integrate with a web router like `react-router` via adapters.
- Optimize layout for desktop:
  - Use responsive design breakpoints.
  - Introduce layout components (e.g., `TwoColumnLayout`, `SidebarLayout`) that adapt based on viewport size.

The goal is an app-like experience, but with desktop-friendly adjustments so long threads and moderation tools remain comfortable.

### 7.4 Design System

Build a design system package using React Native primitives:

- Core components: `Button`, `Text`, `Heading`, `Card`, `ListItem`, `Avatar`, `Badge`, `Modal`, `Sheet`.
- Layout primitives: `Stack`, `Box`, `Grid`, `Spacer`.
- Form components: `TextInput`, `Select`, `Checkbox`, `Radio`, `Switch`.
- Theme tokens: spacing, colors, typography, elevation, border radius.

This package should be platform-aware (e.g., subtle differences between web and native) but offer a single API for screens.

### 7.5 Data Layer

- Use TanStack Query for API fetching, caching, and optimistic updates.
- Provide a typed API client (`packages/shared/apiClient`) wrapping HTTP calls.
- Implement offline support and basic caching strategies for mobile.

---

## 8. Development Workflow & Tooling

### 8.1 Monorepo Tooling

- Package manager: pnpm.
- Task runner: Turborepo, Nx, or custom scripts.
- Linting: ESLint with TypeScript support.
- Formatting: Prettier.
- Testing:
  - Backend: Jest or Vitest.
  - Frontend: React Testing Library, Detox or other E2E tools.

### 8.2 Local Development

- Run backend API and Fedify federation service locally.
- Use Fedify CLI to create an ephemeral inbox server and test federation with real Mastodon/Lemmy instances.
- Use Expo for fast iteration on mobile and web.

### 8.3 CI/CD

- On push/PR:
  - Run tests, lint, type-check.
  - Build backend Docker image.
  - Build mobile app bundles (as needed).
- Deployment pipelines:
  - Backend to staging/production clusters.
  - Web app to CDN/edge network.
  - Mobile apps via app stores (manual or automated using fastlane).

---

## 9. Deployment & Scaling

### 9.1 Baseline Deployment

- Single backend cluster handling HTTP API and federation.
- PostgreSQL deployed with high availability (primary + replica).
- Redis cluster for cache and queues.
- Object storage (S3-compatible) for media.

### 9.2 Federation Scaling

- Use Fedify’s queue and retry mechanisms to scale outgoing activities.
- Separate federation workers from main API nodes for better isolation.
- Implement multi-instance support (multiple Feddit instances) via configuration and hostname routing.

### 9.3 Observability & Reliability

- Collect metrics (requests, queue depth, federation success rates).
- Set up distributed tracing for federation flows.
- Define SLOs for latency, error rates, and inbox/outbox processing times.

---

## 10. Implementation Roadmap

### Phase 1 – Core Platform (Non-Federated)

- Implement domain models, API, and persistence.
- Build React Native app (web + mobile) with basic auth, feeds, communities, posts, comments, votes.

### Phase 2 – ActivityPub Integration with Fedify

- Integrate Fedify and set up actors, inbox, outbox, WebFinger.
- Map Feddit events to ActivityPub activities and vice versa.
- Test interoperability with Mastodon, Lemmy, and other major platforms.

### Phase 3 – Moderation & Advanced Features

- Implement moderation tools (reports, bans, locks, defederation controls).
- Enhance UX for long threads, mod dashboards, and community management.
- Add search and richer media support.

### Phase 4 – Hardening & Scaling

- Optimize performance and federation throughput.
- Add advanced monitoring and alerting.
- Document deployment patterns for other Feddit instances.

---

## 11. Documentation & Open Source Strategy

- Maintain comprehensive developer docs in the repository (architecture, APIs, federation behavior, plugin system).
- Provide instance operator guides for deploying and configuring Feddit.
- Choose a suitable license (e.g., AGPLv3 for strong copyleft, or MPL/Apache 2.0 for more permissive use).
- Encourage community contributions and align with Fediverse Enhancement Proposals (FEPs) where applicable.

This document should evolve alongside implementation, serving as the canonical technical reference for Feddit’s architecture and roadmap.
