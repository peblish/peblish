// Writes src/routeTree.gen.ts (gitignored) without a build: the TanStack Start router
// plugin generates it when Vite resolves the config. `pnpm gen` runs this.
import { join } from 'node:path';
import { resolveConfig } from 'vite';

await resolveConfig({ root: join(import.meta.dirname, '..'), logLevel: 'warn' }, 'build');
