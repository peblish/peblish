import optimizeLocales from '@react-aria/optimize-locales-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nitro } from 'nitro/vite';
import { defineConfig, parseSync, type Plugin, Visitor } from 'vite';

/** The locales the UI ships (src/i18n/negotiate.ts); React Aria's translated strings for any other are dropped from the bundle. */
const locales = ['en-US', 'de-DE'];

// Vendor chunks, named so the payload budget (e2e/payload) can count them exactly: React, Mux UI
// with the React Aria, React Stately and internationalization code it pulls in, and the
// composer's editor (lazy; only the composer route loads it). Nothing else may hold their
// modules: payloadChunks() below records what each chunk contains and the budget check fails
// when a vendor package sits in an app chunk.
const vendorGroups = {
  'vendor-react': /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
  'vendor-mux':
    /[\\/]node_modules[\\/](?:@muxui[\\/]react|react-aria|react-aria-components|react-stately|@react-aria|@react-stately|@react-types|@internationalized|@swc[\\/]helpers|motion|framer-motion|motion-dom|motion-utils|lucide-react|clsx|use-sync-external-store)[\\/]/,
  'vendor-editor':
    /[\\/]node_modules[\\/](?:@tiptap|prosemirror-[\w-]+|orderedmap|rope-sequence|w3c-keyname|crelt|linkifyjs|@remirror)[\\/]|[\\/]@muxui[\\/]react[\\/]generated[\\/]text-editor/,
} as const;

const substrateQuery = '?mux-substrate=';
const substrateHelpers = 'helpers';

const substratePartId = (file: string, part: string) => JSON.stringify(file + substrateQuery + part);

function substrateDrift(file: string, what: string): never {
  throw new Error(
    `peblish:split-mux-substrate: ${what} in ${file}. Mux UI's substrate.js changed shape; update splitMuxSubstrate in vite.config.ts.`,
  );
}

function parseProgram(file: string, code: string) {
  const { program, errors } = parseSync(file, code);
  if (errors.length > 0) substrateDrift(file, 'a parse error');
  return program;
}

/**
 * Each identifier a program reads, with its offset: every Identifier except non-computed member, key and meta-property
 * names. Bindings count too, so a local that shadows a wrapper's name fails closed.
 */
function identifierReads(program: ReturnType<typeof parseProgram>) {
  const reads: { name: string; at: number }[] = [];
  const names = new Set<object>();
  const key = (node: { computed: boolean; key: object }) => void (node.computed || names.add(node.key));
  new Visitor({
    MemberExpression: (node) => void (node.computed || names.add(node.property)),
    Property: (node) => void (node.computed || node.shorthand || names.add(node.key)),
    MethodDefinition: key,
    PropertyDefinition: key,
    AccessorProperty: key,
    MetaProperty: (node) => void names.add(node.meta).add(node.property),
    Identifier: (node) => void (names.has(node) || reads.push({ name: node.name, at: node.start })),
  }).visit(program);
  return reads;
}

/**
 * substrate.js in three parts: its imports, its helpers (every top-level statement that is not exported) and its
 * exported wrappers by name. Each wrapper's module imports only the helpers, so a wrapper or helper that reads another
 * wrapper is drift.
 */
export function splitSubstrate(file: string, code = readFileSync(file, 'utf8')) {
  const imports: string[] = [];
  const helpers: string[] = [];
  const names: string[] = [];
  const wrappers = new Map<string, string>();
  const statements: { node: { start: number; end: number }; wrapper?: string }[] = [];
  const program = parseProgram(file, code);
  for (const node of program.body) {
    const text = code.slice(node.start, node.end);
    if (node.type === 'ImportDeclaration') imports.push(text);
    else if (node.type === 'ExportNamedDeclaration') {
      const declarator = node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations : [];
      const id = declarator.length === 1 ? declarator[0]!.id : undefined;
      if (id?.type !== 'Identifier') substrateDrift(file, 'an export other than `export const AriaX = ...`');
      wrappers.set(id.name, text);
      statements.push({ node, wrapper: id.name });
    } else if (node.type.startsWith('Export')) substrateDrift(file, `an ${node.type}`);
    else {
      if (node.type === 'FunctionDeclaration' && node.id) names.push(node.id.name);
      else if (node.type === 'VariableDeclaration')
        for (const { id } of node.declarations) {
          if (id.type !== 'Identifier') substrateDrift(file, 'a destructured helper');
          names.push(id.name);
        }
      else substrateDrift(file, `a top-level ${node.type}`);
      helpers.push(text);
      statements.push({ node });
    }
  }
  if (wrappers.size === 0) substrateDrift(file, 'no `export const AriaX` wrappers');
  for (const { name, at } of identifierReads(program)) {
    if (!wrappers.has(name)) continue;
    const statement = statements.find(({ node }) => node.start <= at && at < node.end);
    if (statement && statement.wrapper !== name)
      substrateDrift(file, `${statement.wrapper ?? 'a helper'} reading the exported wrapper ${name}`);
  }
  return { imports: imports.join('\n'), helpers: helpers.join('\n'), names: names.join(', '), wrappers };
}

/** Points each `import { AriaX } from './substrate.js'` in a Mux file (`id`) at the module that holds only AriaX. */
export function rewriteSubstrateImports(id: string, code: string) {
  const file = join(dirname(id), 'substrate.js');
  let out = '';
  let last = 0;
  for (const node of parseProgram(id, code).body) {
    if (!('source' in node) || node.source?.value !== './substrate.js') continue;
    if (node.type !== 'ImportDeclaration') substrateDrift(id, 'a re-export of substrate.js');
    if (node.specifiers.length === 0) substrateDrift(id, 'a side-effect-only import of substrate.js');
    const imports = node.specifiers.map((specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
        ? `import { ${specifier.imported.name} as ${specifier.local.name} } from ${substratePartId(file, specifier.imported.name)};`
        : substrateDrift(id, 'a default or namespace import of substrate.js'),
    );
    out += code.slice(last, node.start) + imports.join(' ');
    last = node.end;
  }
  // The rewrite moves code across lines, so client source maps need mappings for it and for the virtual modules first.
  return last === 0 ? null : { code: out + code.slice(last), map: null };
}

/**
 * Splits Mux UI's substrate.js into one module per React Aria wrapper, in the client build only.
 *
 * substrate.js defines every `AriaX` wrapper (`withMuxState(RAC.X, ...)`) in one module, and the bundler assigns
 * chunks by module. Every route reaches substrate.js (Button imports it), so the wrapper of any family some route
 * uses, with the React Aria code behind it (Menu, Modal, Toast, Tooltip, selection, drag and drop), landed in the
 * vendor-mux chunk every route loads. A scratch build that imports only Button does not show it, because there the
 * other wrappers are shaken out. Here each `import { AriaX } from './substrate.js'` in Mux's files points at a module
 * that holds only `AriaX`, which imports substrate's helpers from one shared module, so each family's React Aria code
 * follows the routes that use it. The vendored tarball is untouched, and the rewrite throws when substrate.js changes
 * shape, so a Mux update cannot quietly undo it.
 */
export function splitMuxSubstrate(): Plugin {
  const parts = new Map<string, ReturnType<typeof splitSubstrate>>();
  return {
    name: 'peblish:split-mux-substrate',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId: { filter: { id: /\?mux-substrate=/ }, handler: (source) => source },
    load: {
      filter: { id: /\?mux-substrate=/ },
      handler(id) {
        const at = id.indexOf(substrateQuery);
        const [file, part] = [id.slice(0, at), id.slice(at + substrateQuery.length)];
        const substrate = parts.get(file) ?? splitSubstrate(file);
        parts.set(file, substrate);
        if (part === substrateHelpers)
          return { code: `${substrate.imports}\n${substrate.helpers}\nexport { ${substrate.names} };\n`, moduleSideEffects: false };
        const wrapper = substrate.wrappers.get(part) ?? substrateDrift(file, `no wrapper named ${part}`);
        return {
          code: `${substrate.imports}\nimport { ${substrate.names} } from ${substratePartId(file, substrateHelpers)};\n${wrapper}\n`,
          moduleSideEffects: false,
        };
      },
    },
    transform: {
      filter: { id: /[\\/]@muxui[\\/]react[\\/]generated[\\/][^\\/?]+\.m?js$/, code: './substrate.js' },
      handler: (code, id) => rewriteSubstrateImports(id, code),
    },
  };
}

const declarationQuery = '?mux-declaration=';

function declarationDrift(file: string, what: string): never {
  throw new Error(
    `peblish:split-mux-declarations: ${what} in ${file}. This Mux UI module changed shape; update splitMuxDeclarations in vite.config.ts.`,
  );
}

/**
 * Mux UI modules that hold several families, split one module per top-level declaration in the client build.
 *
 * overlays.js holds Dialog, DropZone, FileTrigger, Popover, PreviewTrigger, Toast and Tooltip. Tree shaking is
 * global, so every export some route uses stays in that one module, and every page loads it because the Sidebar
 * needs its Tooltip: the drop zone's drag and drop, the dialog and the preview trigger came with the Sidebar to every
 * page. Split by declaration, each route loads only the declarations it reaches (5.4 kB gzip less on the home page,
 * 5.7 kB on sign-in, measured 2026-11-11).
 */
const splitByDeclaration = /[\\/]@muxui[\\/]react[\\/]generated[\\/]overlays\.js$/;

/**
 * A module in parts: its imports, and each top-level declaration by its first name with the names it declares and the
 * other declarations it reads. A statement that sets a property on a declaration (`Tooltip.displayName = ...`) goes
 * with it. Fails closed on anything else but imports, function and variable declarations and their named exports, so
 * a Mux update that changes the shape breaks the build instead of the page.
 */
export function splitDeclarations(file: string, code = readFileSync(file, 'utf8')) {
  const program = parseProgram(file, code);
  const imports: string[] = [];
  const declarations = new Map<string, { names: string[]; exported: boolean; text: string; ranges: { start: number; end: number }[] }>();
  const owner = new Map<string, string>();
  for (const node of program.body) {
    const text = code.slice(node.start, node.end);
    if (node.type === 'ImportDeclaration') {
      if (node.specifiers.length === 0) declarationDrift(file, 'a side-effect-only import');
      imports.push(text);
      continue;
    }
    if (node.type === 'ExpressionStatement') {
      const { expression } = node;
      const target =
        expression.type === 'AssignmentExpression' &&
        expression.left.type === 'MemberExpression' &&
        expression.left.object.type === 'Identifier'
          ? declarations.get(owner.get(expression.left.object.name) ?? '')
          : undefined;
      if (!target) declarationDrift(file, 'a top-level expression other than a property set on a declaration');
      target.text += `\n${text}`;
      target.ranges.push({ start: node.start, end: node.end });
      continue;
    }
    const exported = node.type === 'ExportNamedDeclaration';
    const declaration = exported ? node.declaration : node;
    if (exported && (!declaration || node.source)) declarationDrift(file, 'an export list or re-export');
    if (!declaration) declarationDrift(file, `a top-level ${node.type}`);
    let names: string[];
    if (declaration.type === 'FunctionDeclaration' && declaration.id) names = [declaration.id.name];
    else if (declaration.type === 'VariableDeclaration')
      names = declaration.declarations.map(({ id }) =>
        id.type === 'Identifier' ? id.name : declarationDrift(file, 'a destructured declaration'),
      );
    else declarationDrift(file, `a top-level ${declaration.type}`);
    for (const name of names) owner.set(name, names[0]!);
    declarations.set(names[0]!, { names, exported, text, ranges: [{ start: node.start, end: node.end }] });
  }
  const reads = new Map<string, Set<string>>([...declarations.keys()].map((key) => [key, new Set()]));
  for (const { name, at } of identifierReads(program)) {
    const target = owner.get(name);
    if (!target) continue;
    const [reader] = [...declarations].find(([, { ranges }]) => ranges.some(({ start, end }) => start <= at && at < end)) ?? [];
    if (reader && reader !== target) reads.get(reader)!.add(target);
  }
  return { imports: imports.join('\n'), declarations, reads };
}

/**
 * Splits each module matched by `splitByDeclaration` into one virtual module per top-level declaration, client build
 * only. The module itself becomes re-exports of its exported declarations; each part carries the module's imports
 * (unused ones are shaken out) and imports the declarations it reads from their parts. All are side-effect free.
 */
export function splitMuxDeclarations(): Plugin {
  const parts = new Map<string, ReturnType<typeof splitDeclarations>>();
  const partsOf = (file: string) => parts.get(file) ?? parts.set(file, splitDeclarations(file)).get(file)!;
  const partId = (file: string, key: string) => JSON.stringify(file + declarationQuery + key);
  return {
    name: 'peblish:split-mux-declarations',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId: { filter: { id: /\?mux-declaration=/ }, handler: (source) => source },
    load: {
      filter: { id: /\?mux-declaration=/ },
      handler(id) {
        const at = id.indexOf(declarationQuery);
        const [file, key] = [id.slice(0, at), id.slice(at + declarationQuery.length)];
        const { imports, declarations, reads } = partsOf(file);
        const part = declarations.get(key) ?? declarationDrift(file, `no declaration named ${key}`);
        const own = [...reads.get(key)!].map((dependency) => {
          const names = declarations.get(dependency)!.names.join(', ');
          return `import { ${names} } from ${partId(file, dependency)};`;
        });
        const code = [imports, ...own, part.text, part.exported ? '' : `export { ${part.names.join(', ')} };`].join('\n');
        // The parts keep the module's substrate imports, which the substrate split points at single wrappers.
        return { code: rewriteSubstrateImports(file, code)?.code ?? code, moduleSideEffects: false };
      },
    },
    transform: {
      filter: { id: splitByDeclaration },
      handler(_code, id) {
        const exports = [...partsOf(id).declarations].filter(([, { exported }]) => exported);
        const code = exports.map(([key, { names }]) => `export { ${names.join(', ')} } from ${partId(id, key)};`).join('\n');
        return { code, map: null, moduleSideEffects: false };
      },
    },
  };
}

/** Which chunk each package landed in, written next to the build for the budget check (e2e/payload). */
function payloadChunks(): Plugin {
  const packageOf = (id: string) => /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*[\\/]node_modules[\\/])/.exec(id)?.[1];
  return {
    name: 'peblish:payload-chunks',
    apply: 'build',
    writeBundle(options, bundle) {
      if (this.environment.name !== 'client' || !options.dir) return;
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? [
              {
                file: output.fileName,
                entry: output.isEntry,
                packages: [...new Set(output.moduleIds.flatMap((id) => packageOf(id) ?? []))].sort(),
                app: output.moduleIds.some((id) => !/[\\/]node_modules[\\/]/.test(id)),
              },
            ]
          : [],
      );
      const file = join(dirname(options.dir), 'payload-chunks.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ vendorGroups: Object.fromEntries(Object.entries(vendorGroups).map(([name, test]) => [name, test.source])), chunks }, null, 2)}\n`,
      );
    },
  };
}

// Plugin order follows the TanStack Start hosting guide: Start, then Nitro, then React.
// Dev and preview use the lane's port (G0 18300; scripts/lane.sh prints each lane's).
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 18300),
    strictPort: true,
    // File events from a macOS bind mount do not reach a container; poll there instead.
    watch: process.env.VITE_USE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined,
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: { codeSplitting: { groups: Object.entries(vendorGroups).map(([name, test]) => ({ name, test, entriesAware: true })) } },
        },
      },
    },
  },
  plugins: [
    { ...optimizeLocales.vite({ locales }), enforce: 'pre' },
    tanstackStart(),
    // Without '!unwasm', shiki/wasm (pulled in by @muxui/react through @peblish/ui) resolves to
    // onig.wasm, which the SSR environment's bundler cannot link. The JS loader works the same.
    nitro({ preset: 'node-server', exportConditions: ['!unwasm'], plugins: ['./src/server/shutdown.ts'] }),
    viteReact(),
    splitMuxSubstrate(),
    splitMuxDeclarations(),
    payloadChunks(),
  ],
});
