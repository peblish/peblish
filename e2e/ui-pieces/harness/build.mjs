// Builds the harness for e2e/ui-pieces/linked-pieces.spec.ts into the folder given as the first
// argument: `client/` (the browser bundle, with a Vite manifest) and `server/server.mjs` (the
// server render, React and Mux UI bundled in). It uses packages/web's Vite, rooted there so
// React resolves to the web app's copy; nothing is installed for it.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error('usage: node e2e/ui-pieces/harness/build.mjs <out-dir>');
const here = import.meta.dirname;
const web = join(here, '../../../packages/web');
const vite = realpathSync(join(web, 'node_modules/vite'));
const { build } = await import(pathToFileURL(join(vite, 'dist/node/index.js')).href);

const shared = { configFile: false, root: web, publicDir: false, logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] } };
await build({
  ...shared,
  build: { outDir: join(out, 'client'), emptyOutDir: true, manifest: true, rollupOptions: { input: join(here, 'client.jsx') } },
});
await build({
  ...shared,
  ssr: { noExternal: true },
  build: {
    ssr: join(here, 'server.jsx'),
    outDir: join(out, 'server'),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
});
