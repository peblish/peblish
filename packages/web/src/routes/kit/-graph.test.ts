import { join } from 'node:path';
import { createServer, parseSync } from 'vite';
import { expect, test } from 'vitest';

// The client's router entry (src/router.tsx) and the route tree it loads are in every page's script, so
// what their route files import statically is too. The router's code splitter moves a route's component
// into a chunk of its own; what stays (beforeLoad, head, loader) and its imports are shared. This runs the
// app's own Vite config in memory (no build, no server), transforms the router entry for the browser as
// the dev server does, and follows every import through the app's own modules, static and dynamic. Of the gallery, only its route files and
// their guards may be in the shared script, never its compositions, samples or pieces; and no import from
// outside the gallery, static or dynamic, may reach into it, but the route tree's of its route files.
// Imports from inside the gallery are its own business.
const routerEntry = '/src/router.tsx';
const routeTree = '/src/routeTree.gen.ts';
const routeFiles = new Set(['/src/routes/kit/index.tsx', '/src/routes/kit/$composition.tsx']);
const allowed = new Set([...routeFiles, '/src/routes/kit/-enabled.ts', '/src/routes/kit/-render.ts', '/src/routes/kit/-kit.css?url']);

/** The app's and the workspace packages' own modules; installed packages are not followed. */
const own = (request: string) => /^\/(?:src|@fs)\//.test(request) && !request.includes('/node_modules/');
/** A module of the gallery, a split part of one (`?tsr-split=component`) included. */
const inGallery = (url: string) => url.split('?')[0]!.startsWith('/src/routes/kit/');

type Edge = { from: string; to: string; dynamic: boolean };

/** Every import reachable from `entry` through the app's own modules; `source` is a module's code as the browser gets it. */
async function imports(entry: string, source: (url: string) => Promise<string | null>): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const next = [entry];
  for (let url = next.pop(); url !== undefined; url = next.pop()) {
    if (seen.has(url)) continue;
    seen.add(url);
    const code = await source(url);
    if (code === null) continue;
    const { module } = parseSync('module.js', code);
    const statics = [
      ...module.staticImports.map((entry) => entry.moduleRequest.value),
      ...module.staticExports.flatMap((entry) => entry.entries.flatMap((part) => (part.moduleRequest ? [part.moduleRequest.value] : []))),
    ];
    // A dynamic import's request is the source of its argument: a quoted path where the splitter wrote one.
    const dynamics = module.dynamicImports.map(({ moduleRequest }) =>
      code.slice(moduleRequest.start, moduleRequest.end).replace(/^(['"`])(.*)\1$/, '$2'),
    );
    for (const [requests, dynamic] of [
      [statics, false],
      [dynamics, true],
    ] as const)
      for (const to of requests.filter(own)) {
        edges.push({ from: url, to, dynamic });
        next.push(to);
      }
  }
  return edges;
}

/** The modules `entry` loads statically: what is in its chunk. */
function staticallyFrom(entry: string, edges: readonly Edge[]): Set<string> {
  const reached = new Set([entry]);
  for (const url of reached) for (const edge of edges) if (edge.from === url && !edge.dynamic) reached.add(edge.to);
  return reached;
}

/** Imports from outside the gallery into it, but the route tree's static imports of its route files. */
const intrusions = (edges: readonly Edge[]) =>
  edges.filter(({ from, to, dynamic }) => !inGallery(from) && inGallery(to) && !(from === routeTree && !dynamic && routeFiles.has(to)));

/** The graph of modules written here, by address. */
const memory = (modules: Record<string, string>) => imports(routerEntry, async (url) => modules[url] ?? null);

const router = `import { routeTree } from '/src/routeTree.gen.ts';`;
const tree = `import '/src/routes/kit/$composition.tsx';\nimport '/src/routes/post/index.tsx';`;
const galleryRoute = `const lazy = () => import('/src/routes/kit/$composition.tsx?tsr-split=component');`;
const galleryPage = `import '/src/routes/kit/-samples.ts';\nconst page = () => import('/src/routes/kit/-feed.tsx');`;
const postRoute = `const lazy = () => import('/src/routes/post/index.tsx?tsr-split=component');`;

test("the gallery's own imports, static and dynamic, are its business", async () => {
  const edges = await memory({
    [routerEntry]: router,
    [routeTree]: tree,
    '/src/routes/kit/$composition.tsx': galleryRoute,
    '/src/routes/kit/$composition.tsx?tsr-split=component': galleryPage,
    '/src/routes/post/index.tsx': postRoute,
    '/src/routes/post/index.tsx?tsr-split=component': `export const Post = 1;`,
  });
  expect(edges.filter((edge) => edge.dynamic && inGallery(edge.to))).toHaveLength(2);
  expect(intrusions(edges)).toEqual([]);
});

test('a static import of the gallery from another route is caught', async () => {
  const edges = await memory({
    [routerEntry]: router,
    [routeTree]: tree,
    '/src/routes/post/index.tsx': postRoute,
    '/src/routes/post/index.tsx?tsr-split=component': `import { samples } from '/src/routes/kit/-samples.ts';`,
  });
  expect(intrusions(edges)).toEqual([
    { from: '/src/routes/post/index.tsx?tsr-split=component', to: '/src/routes/kit/-samples.ts', dynamic: false },
  ]);
});

test('a dynamic import of the gallery from another route is caught', async () => {
  const edges = await memory({
    [routerEntry]: router,
    [routeTree]: tree,
    '/src/routes/post/index.tsx': postRoute,
    '/src/routes/post/index.tsx?tsr-split=component': `const samples = () => import('/src/routes/kit/-samples.ts');`,
  });
  expect(intrusions(edges)).toEqual([
    { from: '/src/routes/post/index.tsx?tsr-split=component', to: '/src/routes/kit/-samples.ts', dynamic: true },
  ]);
});

test('a dynamic import of the gallery from the router entry is caught', async () => {
  const edges = await memory({
    [routerEntry]: `${router}\nconst kit = () => import('/src/routes/kit/-samples.ts');`,
    [routeTree]: tree,
  });
  expect(intrusions(edges)).toEqual([{ from: routerEntry, to: '/src/routes/kit/-samples.ts', dynamic: true }]);
});

test('no part of the component gallery is in the script every page loads, and no other module imports it', async () => {
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
    const edges = await imports(routerEntry, async (url) => (await client.transformRequest(url))?.code ?? null);
    expect(edges).toContainEqual({ from: routerEntry, to: routeTree, dynamic: false });
    const shared = staticallyFrom(routerEntry, edges);
    expect(shared.has('/src/routes/kit/$composition.tsx')).toBe(true);
    expect([...shared].filter((url) => inGallery(url) && !allowed.has(url))).toEqual([]);
    // Every route's split component is followed.
    expect(edges).toContainEqual({
      from: '/src/routes/post/$id/index.tsx',
      to: '/src/routes/post/$id/index.tsx?tsr-split=component',
      dynamic: true,
    });
    expect(intrusions(edges)).toEqual([]);
  } finally {
    await server.close();
  }
}, 180_000);
