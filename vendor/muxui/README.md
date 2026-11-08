# Vendored Mux UI

`@muxui/react` is pinned to the packed release candidate in this folder, not to npm.
`packages/ui` (the only package that depends on Mux) declares it as
`"@muxui/react": "file:../../vendor/muxui/muxui-react-0.1.0-rc.6.tgz"`, and the lockfile records
the tarball's integrity. Root owns this folder; a lane never changes it.

rc.6 exports `MuxProvider`, which `packages/ui/src/locale.tsx` mounts, so nothing outside
`@muxui/react` imports React Aria and `.npmrc` no longer hoists it. The tarball is MIT licensed
(its `package.json` `license` field and `LICENSE`), so committing it to this AGPL repository is
fine; its bundled notices are in the tarball's `NOTICE` and `licenses/`.

The Dockerfile copies `vendor/muxui/` into the dependency stage before `pnpm fetch`, so the
tarball is in place when the lockfile is read, and CI checks out `vendor/` with the source.

To take a newer candidate (root does this):

1. Check the handed-over SHA-256: `shasum -a 256 vendor/muxui/*.tgz` must match the table.
2. Replace the tarball here, update the table and the `file:` path in `packages/ui/package.json`,
   and run `pnpm install` to regenerate the lockfile.
3. Run `pnpm check`, `pnpm e2e` and `docker build .` before merging.

Swap back to the registry version (and delete the tarball and this table row) when Andrew
publishes it to npm.

| Tarball                      | SHA-256                                                            | Added      |
| ---------------------------- | ------------------------------------------------------------------ | ---------- |
| `muxui-react-0.1.0-rc.6.tgz` | `879b9175ef8be95a73ba58d0ee2edc2dc306dfbf0616b769a5377104ed51f29f` | 2026-11-08 |
