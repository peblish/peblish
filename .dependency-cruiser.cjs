// Package boundaries (frozen G0 contract). Each rule matches both the resolved path and the
// bare specifier, because pnpm's strict layout leaves an undeclared import unresolved.
// tests/boundaries.test.ts cruises the deliberate violations under **/__fixtures__/ and
// asserts that each one fails with its rule.

const pkg = (names) => [`^packages/(${names})/`, `^@peblish/(${names})(/|$)`];
const npm = (names) => [`(^|/node_modules/)(${names})(/|$)`];
const tests = '\\.(test|test-d)\\.tsx?$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'schema-is-a-leaf',
      comment: 'schema (MIT) imports no other workspace package.',
      severity: 'error',
      from: { path: '^packages/schema/' },
      to: { path: pkg('core|federation|ui|web') },
    },
    {
      name: 'ui-imports-schema-only',
      comment: 'ui (MIT) may import schema and Mux UI, nothing else from the workspace.',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: pkg('core|federation|web') },
    },
    {
      name: 'core-imports-schema-only',
      comment: 'core may import schema only.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: pkg('federation|ui|web') },
    },
    {
      name: 'federation-imports-core-and-schema',
      comment: 'federation may import core and schema only.',
      severity: 'error',
      from: { path: '^packages/federation/' },
      to: { path: pkg('ui|web') },
    },
    {
      name: 'mux-only-in-ui',
      comment: 'Mux UI and React Aria are reached only through the ui facade.',
      severity: 'error',
      from: { pathNot: '^packages/ui/' },
      to: { path: npm('@muxui/react|react-aria-components|react-aria') },
    },
    {
      name: 'fedify-only-in-federation',
      comment: '@fedify/* is confined to packages/federation.',
      severity: 'error',
      from: { pathNot: '^packages/federation/' },
      to: { path: npm('@fedify/[^/]+') },
    },
    {
      name: 'web-no-database',
      comment: 'web reaches the database only through core services, never the driver or core/db, core/tx.',
      severity: 'error',
      from: { path: '^packages/web/' },
      to: {
        path: [...npm('postgres|drizzle-orm|drizzle-kit'), '^packages/core/src/(db|tx|testing)/', '^@peblish/core/(db|tx|testing)(/|$)'],
      },
    },
    {
      name: 'authz-brand',
      comment: 'Only authorize() issues grants and only mutations verify them; everyone else imports brand.ts for types.',
      severity: 'error',
      from: { pathNot: ['^packages/core/src/authz/authorize\\.ts$', '^packages/core/src/tx/mutation\\.ts$', tests] },
      to: { path: '^packages/core/src/authz/brand\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'core-writer-access',
      comment:
        'The writable pool is for core/db, core/tx, core/outbox, test helpers and better-auth (core/identity, lane A). Everything else writes through a mutation.',
      severity: 'error',
      from: {
        pathNot: ['^packages/core/src/(db|tx|outbox|testing|identity)/', '^packages/core/src/lifecycle\\.ts$', tests, '^tests/'],
      },
      to: { path: ['^packages/core/src/db/(write|pools)\\.ts$', '^@peblish/core/db/(write|pools)$'] },
    },
    {
      name: 'core-tx-access',
      comment: 'Raw transactions are for mutations, the outbox worker and the inbound federation pipeline.',
      severity: 'error',
      from: { pathNot: ['^packages/core/src/(tx|outbox|testing)/', '^packages/federation/src/inbound/', tests] },
      to: { path: ['^packages/core/src/tx/tx\\.ts$', '^@peblish/core/tx/tx$'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-test-helpers-in-product',
      comment: 'core/testing is for tests only.',
      severity: 'error',
      from: { pathNot: ['^packages/core/src/testing/', tests, '^tests/'] },
      to: { path: ['^packages/core/src/testing/', '^@peblish/core/testing(/|$)'] },
    },
    {
      name: 'no-circular',
      comment: 'No runtime import cycles (type-only cycles are fine).',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import resolves (Vite ?url imports excepted).',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '\\?(url|raw)$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['/__fixtures__/', '(^|/)node_modules/', '/\\.output/', '/dist/', '/\\.tanstack/'] },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'module', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
