# Vendored Mux UI

`@muxui/react` is pinned to the packed release candidate in this folder, not to npm.
`packages/ui` (the only package that depends on Mux) declares it as
`"@muxui/react": "file:../../vendor/muxui/muxui-react-0.1.0-rc.7.tgz"`, and the lockfile records
the tarball's integrity. Root owns this folder; a lane never changes it.

rc.7 exports `MuxProvider`, which `packages/ui/src/locale.tsx` mounts, so nothing outside
`@muxui/react` imports React Aria and `.npmrc` no longer hoists it. The tarball is MIT licensed
(its `package.json` `license` field and `LICENSE`), so committing it to this AGPL repository is
fine; its bundled notices are in the tarball's `NOTICE` and `licenses/`.

rc.7 is a local build and is not published. It was packed from branch `peblish-rc7-pack` of
`ndrewtran/muxui`: `peblish-rc` (what rc.6 was built from) merged with Mux UI's `main` (36144ea8),
the three fix branches peblish asked for (`fix/table-tabs-sidebar-state`,
`fix/link-button-disclosure-attributes`, `fix/field-errors-and-native-state`), the unmerged
`chore/release-contract-versions`, and one CSS comment line that lets release preparation pack it.
A registry release with the same version number may differ, so the swap back to npm is a real
upgrade to check, not a rename.

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
| `muxui-react-0.1.0-rc.7.tgz` | `3a9f072f1da4f3bc47df89428c5e81de85f1dcd5f24b451c071d9960649a40e3` | 2026-11-12 |
