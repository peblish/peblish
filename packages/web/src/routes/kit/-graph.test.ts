import { join } from 'node:path';
import { createServer, parseSync } from 'vite';
import { expect, test } from 'vitest';

// The route tree is in every page's script, so what its route files import statically is too. The
// router's code splitter moves a route's component into a chunk of its own; what stays (beforeLoad,
// head, loader) and its imports are shared. This runs the app's own Vite config in memory (no build,
// no server), transforms the route tree for the browser as the dev server does, and follows its
// static imports through the app's own modules: of the gallery, only its route files and their guards
// may be there, never its compositions, samples or pieces.
const allowed = new Set([
  '/src/routes/kit/index.tsx',
  '/src/routes/kit/$composition.tsx',
  '/src/routes/kit/-enabled.ts',
  '/src/routes/kit/-render.ts',
  '/src/routes/kit/-kit.css?url',
]);

test('no part of the component gallery is in the script every page loads', async () => {
  const root = join(import.meta.dirname, '../../..');
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, ws: false },
    // Packages are not followed, so they need not be prebundled.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const client = server.environments.client;
    const seen = new Set<string>();
    const next = ['/src/routeTree.gen.ts'];
    for (let url = next.pop(); url !== undefined; url = next.pop()) {
      if (seen.has(url)) continue;
      seen.add(url);
      const result = await client.transformRequest(url);
      if (!result) continue;
      const { module } = parseSync('module.js', result.code);
      const requests = [
        ...module.staticImports.map((entry) => entry.moduleRequest.value),
        ...module.staticExports.flatMap((entry) => entry.entries.flatMap((part) => (part.moduleRequest ? [part.moduleRequest.value] : []))),
      ];
      // The app's and the workspace packages' own modules; installed packages are not followed.
      for (const request of requests) if (/^\/(?:src|@fs)\//.test(request) && !request.includes('/node_modules/')) next.push(request);
    }
    expect(seen.has('/src/routes/kit/$composition.tsx')).toBe(true);
    expect([...seen].filter((url) => url.startsWith('/src/routes/kit/') && !allowed.has(url))).toEqual([]);
  } finally {
    await server.close();
  }
}, 60_000);
