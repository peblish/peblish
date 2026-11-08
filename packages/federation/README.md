# @peblish/federation

Everything ActivityPub, on Fedify 2.4. This is the only package that imports `@fedify/*`
(lint rule `fedify-only-in-federation`). Skeleton only after G0; lanes FED-A and FED-B
build it out.

## Inbound processing

Each inbound activity is stored in `inbox_raw` first, then one transaction (`tx` from
`@peblish/core/tx/tx`) writes its dedupe marker, applies it through a core mutation and
enqueues the resulting outbox events. Handlers live one per activity type in
`src/inbound/handlers/<type>.ts` (each exports `handler`), registered by glob.

Dedupe rule: the id passed to `Tx.dedupe` (stored in `inbox_dedupe`) is the id of the
activity being applied, which is the inner activity when it arrives inside an Announce.
A Create delivered directly by its author and the same Create relayed by the community's
Announce are therefore applied once. Lane FED-A implements this rule where it unwraps
Announces.

## HTTP and consumers

`src/http.ts` is the HTTP seam. Web's server entry (`packages/web/src/server.ts`, through
`packages/web/src/server/federation.ts`) sends `isFederationRequest` matches to
`handleFederationRequest` before any UI route matches. Those are the `/ap/*`,
`/.well-known/webfinger`, `/.well-known/nodeinfo`, `/nodeinfo/*`, `/inbox` and `/outbox`
paths, `/u/<name>` and `/c/<name>` with their `/inbox` and `/outbox`, and `/` when Accept
prefers ActivityPub JSON. A `null` answer falls through to the UI route, so a page path
still renders HTML. Federation's outbox consumers live in `src/<area>/consumer.ts`, and the
worker runs them beside core's. G0 created these files and the web bridge; lane FED-A owns
`http.ts` and its consumers from here. Web may import only `@peblish/federation/http` and the
consumer registry (lint rule `web-federation-entry-points`).
