# Vendored Mux UI

`@muxui/react` is pinned to `0.1.0-rc.5` from npm until the MUX lane delivers a packed
release candidate. The hook for swapping to it (root does this, not a lane):

1. MUX runs `pnpm pack` in `/Users/admin/Projects/muxui` and hands over
   `muxui-react-<version>.tgz` with its SHA-256.
2. Root commits the tarball here as `vendor/muxui/muxui-react-<version>.tgz` and records the
   checksum below (`shasum -a 256 vendor/muxui/*.tgz` must match).
3. Root changes the dependency in `packages/ui/package.json` (the only package that depends
   on Mux) to `"@muxui/react": "file:../../vendor/muxui/muxui-react-<version>.tgz"` and runs
   `pnpm install` to regenerate the lockfile.
4. If that rc exports a locale provider, `packages/ui/src/locale.tsx` switches to it and the
   `public-hoist-pattern[]=react-aria-components` line leaves `.npmrc`.

The Dockerfile copies `vendor/muxui/` into the dependency stage before `pnpm fetch`, so the
tarball is in place when the lockfile is read, and CI checks out `vendor/` with the source.
Neither is proven until a tarball exists: after step 3, root runs `docker build .` and the CI
image job before merging. Swap back to the registry version when Andrew publishes it. Confirm the Mux licence permits
committing the tarball to this AGPL repository before step 2 (it is MIT at rc.5).

| Tarball    | SHA-256 | Added |
| ---------- | ------- | ----- |
| (none yet) |         |       |
