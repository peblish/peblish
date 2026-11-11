import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// The payload budget Andrew approved (/Users/admin/Projects/muxui-peblish-rc/PAYLOAD.md,
// "Proposed budget for peblish"). Per route, first visit, bytes transferred (gzip, or woff2 as
// sent), kB of 1000 bytes, excluding app code, the router and the HTML. The gzip is the
// check's own: nothing in this repository compresses responses, Traefik (Easypanel) or
// Cloudflare does in production (deploy/README.md), so the figures are the compressible bytes
// a compressing proxy would send, not what the Node server itself sends.
// The script budget is per page, in routes.ts. css, and the editor chunk on the composer's
// signed-out page, are still report-only as they were during the Mux UI restyle (PAYLOAD.md).
export const budget = {
  /** Mux UI's styles.css alone. */
  css: 65_000,
  /** Regular, italic and code faces on a Latin page. */
  fonts: 270_000,
  /** The composer's lazy editor chunk, on top of the above. */
  editor: 200_000,
} as const;

/**
 * A page's budget for React, React DOM and Mux UI (with React Aria pruned to en-US and de-DE) on
 * its first visit, in kB of 1,000 bytes. `budget` is the limit, stored as the number itself; the
 * rest is the record of where it came from, so a reviewer sees the headroom.
 */
export interface ScriptBudget {
  /** The limit: `measured` plus 5%, rounded up to 0.1 kB, when it was set. */
  budget: number;
  /** What the page measured then (the largest of three runs). */
  measured: number;
  /** When it was measured, YYYY-MM-DD. */
  on: string;
}

/** The limit in bytes; rounded, so 192.6 kB is exactly 192,600 bytes and not a float just under it. */
export const scriptLimit = ({ budget }: ScriptBudget) => Math.round(budget * 1000);

/** What a page over its script budget fails with: the page, the figures, and what to do next. */
export const scriptOver = (page: string, bytes: number, js: ScriptBudget) =>
  `${page}: React and Mux UI JS is ${(bytes / 1000).toFixed(1)} kB, over its budget of ${js.budget.toFixed(1)} kB (measured ${js.measured.toFixed(1)} kB on ${js.on}). ` +
  `Find what grew; if the growth is intended, re-measure (PAYLOAD.md) and raise this page's js budget in e2e/payload/routes.ts in the same pull request, with the reason.`;

export const gzipSize = (body: Buffer) => gzipSync(body, { level: 9 }).length;

/** What vite.config.ts writes beside the client build: the packages inside each chunk. */
export interface Manifest {
  vendorGroups: Record<string, string>;
  chunks: { file: string; entry: boolean; packages: string[]; app: boolean }[];
}

const manifestPath = join(import.meta.dirname, '../../packages/web/.output/payload-chunks.json');

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * The groups packages/web/vite.config.ts defines, each with a package its pattern must match: a
 * pattern that matches nothing (or a group that went missing) would make misplacedPackages
 * report nothing while react-dom sits in an app chunk.
 */
const expectedGroups = { 'vendor-react': 'react-dom', 'vendor-mux': '@muxui/react', 'vendor-editor': '@tiptap/core' } as const;

function matchesPackage(source: unknown, pkg: string): boolean {
  if (typeof source !== 'string') return false;
  try {
    return new RegExp(source).test(`/node_modules/${pkg}/`);
  } catch {
    return false;
  }
}

/** A plain object with exactly the expected groups, each a valid pattern that matches its package. */
function isVendorGroups(value: unknown): value is Manifest['vendorGroups'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const names = Object.keys(value).sort();
  return (
    names.join() === Object.keys(expectedGroups).sort().join() &&
    Object.entries(expectedGroups).every(([name, pkg]) => matchesPackage(Reflect.get(value, name), pkg))
  );
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null || !('vendorGroups' in value) || !('chunks' in value)) return false;
  const { vendorGroups, chunks } = value;
  return (
    isVendorGroups(vendorGroups) &&
    Array.isArray(chunks) &&
    chunks.every(
      (chunk: unknown) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'file' in chunk &&
        typeof chunk.file === 'string' &&
        'entry' in chunk &&
        typeof chunk.entry === 'boolean' &&
        'app' in chunk &&
        typeof chunk.app === 'boolean' &&
        'packages' in chunk &&
        isStrings(chunk.packages),
    )
  );
}

/** Parses a manifest; anything else throws, so a broken file cannot pass for "nothing to check". */
export function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!isManifest(value))
    throw new Error(
      'payload-chunks.json is not a manifest: expected vendorGroups (vendor-react, vendor-mux and vendor-editor, each a pattern matching its package) and chunks (see packages/web/vite.config.ts)',
    );
  return value;
}

/**
 * The build's manifest. A local run (Playwright starts the production build itself) must have
 * one: a missing or invalid file throws, because the vendor-placement guarantee would otherwise
 * switch off unnoticed when the build plugin stops writing it. Only a remote BASE_URL (a
 * running server, such as the Docker image, with no build output beside it) has none, and gets null.
 */
export function loadManifest({ remote, path = manifestPath }: { remote: boolean; path?: string }): Manifest | null {
  if (remote) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `the build did not write ${path} (pnpm build runs the peblish:payload-chunks plugin in vite.config.ts): ${String(error)}`,
    );
  }
  return parseManifest(text);
}

/** Which budget a script file counts against, by the vendor chunk's name; null for app code. */
export function vendorKind(file: string): 'react' | 'mux' | 'editor' | null {
  return /(?:^|\/)vendor-(react|mux|editor)\b/.exec(file)?.[1] as 'react' | 'mux' | 'editor' | null;
}

/**
 * Chunks that break the vendor rule: a vendor chunk holding a package of another vendor
 * group, or an app chunk holding a vendor package (it would escape the count).
 */
export function misplacedPackages(manifest: Manifest): string[] {
  const groups = Object.entries(manifest.vendorGroups).map(([name, source]) => [name.replace(/^vendor-/, ''), new RegExp(source)] as const);
  const groupOf = (pkg: string) => groups.find(([, pattern]) => pattern.test(`/node_modules/${pkg}/`))?.[0];
  return manifest.chunks.flatMap(({ file, packages }) => {
    const kind = vendorKind(file);
    return packages.flatMap((pkg) => {
      const group = groupOf(pkg);
      return group !== undefined && group !== kind ? [`${file} holds ${pkg} (a ${group} package)`] : [];
    });
  });
}

/** themes.css rules select `[data-muxui-theme=...]`; styles.css has none. */
export const hasThemeRules = (css: string) => css.includes('data-muxui-theme');
