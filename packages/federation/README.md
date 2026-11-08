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
