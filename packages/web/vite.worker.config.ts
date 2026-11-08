import { defineConfig } from 'vite';

// The worker and migrate processes, and the one-off first-admin script (admin-cli.ts, run as
// `node /app/processes/admin.mjs` in the image): plain Node entries bundled with every
// dependency, so the runtime image needs only node and dist/processes (plus core's migrations folder).
export default defineConfig({
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'dist/processes',
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: { worker: 'src/worker.ts', migrate: '../core/src/db/migrate-cli.ts', admin: '../core/src/identity/admin-cli.ts' },
      output: { entryFileNames: '[name].mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
