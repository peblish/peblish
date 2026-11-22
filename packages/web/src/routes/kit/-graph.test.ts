import { join } from 'node:path';
import { createServer, parseSync } from 'vite';
import { expect, test } from 'vitest';

// The route tree is in every page's script, so what its route files import statically is too. The
// router's code splitter moves a route's component into a chunk of its own; what stays (beforeLoad,
// head, loader) and its imports are shared. This runs the app's own Vite config in memory (no build,
// no server), transforms the route tree for the browser as the dev server does, and follows its
// static imports through the app's own modules: of the gallery, only its route files and their guards
// may be there, never its compositions, samples or pieces. It then follows every other route's split
// component (each dynamic import outside the gallery's routes) the same way: none may reach the gallery.
const allowed = new Set([
  '/src/routes/kit/index.tsx',
  '/src/routes/kit/$composition.tsx',
  '/src/routes/kit/-enabled.ts',
  '/src/routes/kit/-render.ts',
  '/src/routes/kit/-kit.css?url',
]);

/** The app's and the workspace packages' own modules; installed packages are not followed. */
const own = (request: string) => /^\/(?:src|@fs)\//.test(request) && !request.includes('/node_modules/');

test('no part of the component gallery is in the script every page loads, nor in another route’s own chunk', async () => {
  const root = join(import.meta.dirname, '../../..');
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    // A cache of its own: the dev server's prebundled packages are in the default one, and this server would
    // replace them, so a dev server running beside the tests would then fail a page that loads one of them first.
    cacheDir: join(root, 'node_modules/.vite-graph-test'),
    server: { middlewareMode: true, hmr: false, ws: false },
    // Packages are not followed, so they need not be prebundled.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const client = server.environments.client;
    /** Follows the static imports from `next`, adding each module to `seen`; the dynamic ones go to `split`. */
    async function walk(next: string[], seen: Set<string>, split: string[]) {
      for (let url = next.pop(); url !== undefined; url = next.pop()) {
        if (seen.has(url)) continue;
        seen.add(url);
        const result = await client.transformRequest(url);
        if (!result) continue;
        const { module } = parseSync('module.js', result.code);
        const requests = [
          ...module.staticImports.map((entry) => entry.moduleRequest.value),
          ...module.staticExports.flatMap((entry) =>
            entry.entries.flatMap((part) => (part.moduleRequest ? [part.moduleRequest.value] : [])),
          ),
        ];
        next.push(...requests.filter(own));
        // A dynamic import's request is the source of its argument: a quoted path where the splitter wrote one.
        const dynamic = module.dynamicImports.map(({ moduleRequest }) => result.code.slice(moduleRequest.start, moduleRequest.end));
        split.push(...dynamic.map((request) => request.replace(/^(['"`])(.*)\1$/, '$2')).filter(own));
      }
    }
    const shared = new Set<string>();
    const split: string[] = [];
    await walk(['/src/routeTree.gen.ts'], shared, split);
    expect(shared.has('/src/routes/kit/$composition.tsx')).toBe(true);
    expect([...shared].filter((url) => url.startsWith('/src/routes/kit/') && !allowed.has(url))).toEqual([]);

    // The gallery's own split components are its business; every other one, and what it splits off in turn, is followed.
    const elsewhere = (url: string) => !url.startsWith('/src/routes/kit/');
    const queue = split.filter(elsewhere);
    expect(queue).toContain('/src/routes/post/$id/index.tsx?tsr-split=component');
    const reached = new Set(shared);
    while (queue.length > 0) {
      const more: string[] = [];
      await walk(queue.splice(0), reached, more);
      queue.push(...more.filter(elsewhere));
    }
    expect([...reached].filter((url) => !shared.has(url) && url.startsWith('/src/routes/kit/'))).toEqual([]);
  } finally {
    await server.close();
  }
}, 180_000);
