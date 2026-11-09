// Writes the glob registries (*.gen.ts, gitignored). Adding a file that matches a glob below
// registers it; no shared index file is edited, so parallel lanes never collide.
// Run with `pnpm gen`; check, build, test and typecheck run it first.
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

// GEN_ROOT points the generator at another tree (scripts/gen.test.ts).
const root = process.env.GEN_ROOT ?? join(import.meta.dirname, '..');

type Registry = {
  /** Generated file, relative to the repository root. */
  out: string;
  /** Glob of the registered files, relative to the repository root. Files starting with `_` are helpers, never registered. */
  files: string;
  /** Named export each registered file must provide, or 'default' for JSON. */
  exportName: string;
  /**
   * 'object': each file exports a map; the registry spreads them into `merged` (keys must be
   * disjoint, asserted by the consumer of the registry) and keeps `areas` for that check.
   * 'list': each file exports one item; the registry is a typed array.
   */
  kind: { merge: 'object'; areas: string; merged: string } | { merge: 'list'; list: string; itemType: { name: string; from: string } };
};

const registries: Registry[] = [
  {
    out: 'packages/schema/src/registry/events.gen.ts',
    files: 'packages/schema/src/events/*.ts',
    exportName: 'events',
    kind: { merge: 'object', areas: 'eventAreas', merged: 'eventSchemas' },
  },
  {
    out: 'packages/schema/src/registry/refusals.gen.ts',
    files: 'packages/schema/src/refusals/*.ts',
    exportName: 'refusals',
    kind: { merge: 'object', areas: 'refusalAreas', merged: 'refusalDescriptions' },
  },
  {
    out: 'packages/core/src/registry/policies.gen.ts',
    files: 'packages/core/src/authz/actions/*.ts',
    exportName: 'policies',
    kind: { merge: 'object', areas: 'policyAreas', merged: 'policies' },
  },
  {
    out: 'packages/core/src/registry/consumers.gen.ts',
    files: 'packages/core/src/**/consumer.ts',
    exportName: 'consumer',
    kind: { merge: 'list', list: 'consumers', itemType: { name: 'Consumer', from: 'packages/core/src/outbox/consumers.ts' } },
  },
  {
    out: 'packages/core/src/registry/feed-predicates.gen.ts',
    files: 'packages/core/src/*/feed-predicate.ts',
    exportName: 'feedPredicate',
    kind: { merge: 'list', list: 'feedPredicates', itemType: { name: 'FeedPredicate', from: 'packages/core/src/registry/types.ts' } },
  },
  {
    out: 'packages/federation/src/registry/inbound-handlers.gen.ts',
    files: 'packages/federation/src/inbound/handlers/*.ts',
    exportName: 'handler',
    kind: {
      merge: 'list',
      list: 'inboundHandlers',
      itemType: { name: 'InboundHandler', from: 'packages/federation/src/inbound/handler.ts' },
    },
  },
  {
    // Federation's own consumers (delivery, lane FED-A); the worker runs both lists.
    out: 'packages/federation/src/registry/consumers.gen.ts',
    files: 'packages/federation/src/**/consumer.ts',
    exportName: 'consumer',
    kind: { merge: 'list', list: 'federationConsumers', itemType: { name: 'Consumer', from: '@peblish/core/outbox/consumers' } },
  },
  {
    out: 'packages/web/src/registry/i18n.gen.ts',
    files: 'packages/web/src/i18n/*.json',
    exportName: 'default',
    kind: { merge: 'object', areas: 'catalogues', merged: 'mergedCatalogues' },
  },
];

/** Not registered: tests, generated files, and helpers whose file name starts with `_`. */
const ignored = (file: string) => /\.(test|test-d|gen|spec)\.tsx?$/.test(file) || basename(file).startsWith('_');

/** A stable key for a registered file: `posts`, `outbox_self_check`, `delete`. */
function identifier(file: string, base: string): string {
  const stem = relative(base, file)
    .replace(/\.(tsx?|json)$/, '')
    .replace(/\/(consumer|feed-predicate)$/, '');
  return stem.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ? `_${next}` : ''));
}

function importPath(from: string, to: string): string {
  if (to.startsWith('@')) return to;
  const path = relative(dirname(from), join(root, to));
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * Every binding is prefixed (r_<key>), so a file named after a reserved word (delete.ts) or
 * after the registry's own export (policies.ts) still generates valid code. Two files with
 * the same key (a-b and a_b) are an error.
 */
function render(registry: Registry): string {
  const out = join(root, registry.out);
  const base = join(root, registry.files.slice(0, registry.files.indexOf('*')));
  const files = globSync(registry.files, { cwd: root })
    .map((file) => join(root, file))
    .filter((file) => !ignored(file))
    .sort();
  const seen = new Map<string, string>();
  const entries = files.map((file) => {
    const key = identifier(file, base);
    const clash = seen.get(key);
    if (clash) throw new Error(`gen: ${relative(root, clash)} and ${relative(root, file)} both register as '${key}'; rename one`);
    seen.set(key, file);
    return { key, binding: `r_${key}`, path: importPath(out, relative(root, file)) };
  });
  const lines = [`// Generated by scripts/gen.ts from ${registry.files}. Do not edit; run \`pnpm gen\`.`];
  for (const { binding, path } of entries) {
    lines.push(
      registry.exportName === 'default'
        ? `import ${binding} from '${path}';`
        : `import { ${registry.exportName} as ${binding} } from '${path}';`,
    );
  }
  const { kind } = registry;
  if (kind.merge === 'object') {
    lines.push('', `export const ${kind.areas} = { ${entries.map(({ key, binding }) => `'${key}': ${binding}`).join(', ')} };`);
    lines.push(`export const ${kind.merged} = { ${entries.map(({ binding }) => `...${binding}`).join(', ')} };`);
  } else {
    lines.splice(1, 0, `import type { ${kind.itemType.name} } from '${importPath(out, kind.itemType.from)}';`);
    lines.push('', `export const ${kind.list}: readonly ${kind.itemType.name}[] = [${entries.map(({ binding }) => binding).join(', ')}];`);
  }
  return `${lines.join('\n')}\n`;
}

for (const registry of registries) {
  const out = join(root, registry.out);
  const next = render(registry);
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    // First run: nothing generated yet.
  }
  if (current === next) continue;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, next);
  console.log(`gen: wrote ${registry.out}`);
}
