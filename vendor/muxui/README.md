# Vendored Mux UI

`@muxui/react` is pinned to the packed release candidate in this folder, not to npm.
`packages/ui` (the only package that depends on Mux) declares it as
`"@muxui/react": "file:../../vendor/muxui/muxui-react-0.1.0-rc.8-c3.tgz"`, and the lockfile records
the tarball's integrity. Root owns this folder; a lane never changes it.

Since rc.7 it exports `MuxProvider`, which `packages/ui/src/locale.tsx` mounts, so nothing outside
`@muxui/react` imports React Aria and `.npmrc` no longer hoists it. The tarball is MIT licensed
(its `package.json` `license` field and `LICENSE`), so committing it to this AGPL repository is
fine; its bundled notices are in the tarball's `NOTICE` and `licenses/`.

The tarball is candidate c3 of `@muxui/react` 0.1.0-rc.8. Mux UI's release workflow built it in a
dry run that publishes nothing (run 44942493472, from `main` of `ndrewtran/muxui` at 6c93ef95), and
listed its sha512 in the run's release manifest; the lockfile's integrity is that same value. A
dry run does not move the registry's version, so every candidate cut this way carries the same
version number: each is vendored under a file name that names the candidate (`-c1`, `-c3`, ...),
and the file name, not the version, tells them apart. Candidate c1 (run 44924382937, at dde5924a)
came before it here; c2 was never vendored. The `muxui-react-0.1.0-rc.8.tgz` vendored before c1
was a different, older local build (branch `peblish-rc8-pack`) with the same version number. A
registry release with that version may differ again, so the swap back to npm is a real upgrade to
check, not a rename.

The Dockerfile copies `vendor/muxui/` into the dependency stage before `pnpm fetch`, so the
tarball is in place when the lockfile is read, and CI checks out `vendor/` with the source.

To take a newer candidate (root does this):

1. Check the handed-over checksums: the sha512 must equal the one the release workflow's manifest
   lists for the tarball, and `shasum -a 256 vendor/muxui/*.tgz` must match the table.
2. Replace the tarball here under its candidate file name, update the table and the `file:` path in
   `packages/ui/package.json`, run `pnpm install` to regenerate the lockfile, and check that the
   lockfile's integrity for the tarball is the manifest's sha512.
3. Run `pnpm check`, `pnpm e2e` and `docker build .` before merging.

Swap back to the registry version (and delete the tarball and this table row) when Andrew
publishes it to npm.

| Tarball                         | SHA-256                                                            | Added      |
| ------------------------------- | ------------------------------------------------------------------ | ---------- |
| `muxui-react-0.1.0-rc.8-c3.tgz` | `83b6a260bf3f9de855859fea40eac53aeb0e7ae26bf0c82d36ac79299a610fa0` | 2026-11-22 |
