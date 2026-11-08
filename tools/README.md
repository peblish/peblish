# tools

Developer and test tooling that is not part of the product, one private workspace package per
tool (`tools/<name>/package.json` with `"private": true`). A tool depends on the packages it
needs (`"@peblish/core": "workspace:*"`), so it resolves them like any workspace package.

- It may import any package, including core's write pool and test helpers. Nothing imports a
  tool (lint rule `nothing-imports-tools`).
- `pnpm typecheck` checks it through the root `tsconfig.json`; give it its own `tsconfig.json`
  and `typecheck` script too when it needs different compiler settings.
- Tests in `tools/<name>/src/**/*.test.ts` run in the `tools` vitest project against the
  lane's test database, as core's do.
- Dependency additions go in LANE-NOTES.md, and root regenerates the lockfile.
