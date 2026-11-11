import optimizeLocales from '@react-aria/optimize-locales-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nitro } from 'nitro/vite';
import { defineConfig, parseSync, type Plugin } from 'vite';

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

/** substrate.js in three parts: its imports, its helpers (every top-level statement that is not exported) and its exported wrappers by name. */
function splitSubstrate(file: string) {
  const code = readFileSync(file, 'utf8');
  const imports: string[] = [];
  const helpers: string[] = [];
  const names: string[] = [];
  const wrappers = new Map<string, string>();
  for (const node of parseProgram(file, code).body) {
    const text = code.slice(node.start, node.end);
    if (node.type === 'ImportDeclaration') imports.push(text);
    else if (node.type === 'ExportNamedDeclaration') {
      const declarator = node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations : [];
      const id = declarator.length === 1 ? declarator[0]!.id : undefined;
      if (id?.type !== 'Identifier') substrateDrift(file, 'an export other than `export const AriaX = ...`');
      wrappers.set(id.name, text);
    } else if (node.type.startsWith('Export')) substrateDrift(file, `an ${node.type}`);
    else {
      if (node.type === 'FunctionDeclaration' && node.id) names.push(node.id.name);
      if (node.type === 'VariableDeclaration')
        for (const { id } of node.declarations) {
          if (id.type !== 'Identifier') substrateDrift(file, 'a destructured helper');
          names.push(id.name);
        }
      helpers.push(text);
    }
  }
  if (wrappers.size === 0) substrateDrift(file, 'no `export const AriaX` wrappers');
  return { imports: imports.join('\n'), helpers: helpers.join('\n'), names: names.join(', '), wrappers };
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
  const partId = (file: string, part: string) => JSON.stringify(file + substrateQuery + part);
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
          code: `${substrate.imports}\nimport { ${substrate.names} } from ${partId(file, substrateHelpers)};\n${wrapper}\n`,
          moduleSideEffects: false,
        };
      },
    },
    transform: {
      filter: { id: /[\\/]@muxui[\\/]react[\\/]generated[\\/][^\\/?]+\.m?js$/, code: './substrate.js' },
      handler(code, id) {
        const file = join(dirname(id), 'substrate.js');
        let out = '';
        let last = 0;
        for (const node of parseProgram(id, code).body) {
          if (!('source' in node) || node.source?.value !== './substrate.js') continue;
          if (node.type !== 'ImportDeclaration') substrateDrift(id, 'a re-export of substrate.js');
          const imports = node.specifiers.map((specifier) =>
            specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
              ? `import { ${specifier.imported.name} as ${specifier.local.name} } from ${partId(file, specifier.imported.name)};`
              : substrateDrift(id, 'a default or namespace import of substrate.js'),
          );
          out += code.slice(last, node.start) + imports.join(' ');
          last = node.end;
        }
        return last === 0 ? null : { code: out + code.slice(last), map: null };
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
    payloadChunks(),
  ],
});
