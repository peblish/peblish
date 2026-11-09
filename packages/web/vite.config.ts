import optimizeLocales from '@react-aria/optimize-locales-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';

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
    payloadChunks(),
  ],
});
