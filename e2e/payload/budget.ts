import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// The payload budget Andrew approved (/Users/admin/Projects/muxui-peblish-rc/PAYLOAD.md,
// "Proposed budget for peblish"). Per route, first visit, bytes transferred (gzip, or woff2 as
// sent), kB of 1000 bytes, excluding app code, the router and the HTML. The gzip is the
// check's own: nothing in this repository compresses responses, Traefik (Easypanel) or
// Cloudflare does in production (deploy/README.md), so the figures are the compressible bytes
// a compressing proxy would send, not what the Node server itself sends.
export const budget = {
  /** React, React DOM and Mux UI with React Aria pruned to en-US and de-DE. */
  js: 170_000,
  /** Mux UI's styles.css alone. */
  css: 65_000,
  /** Regular, italic and code faces on a Latin page. */
  fonts: 270_000,
  /** The composer's lazy editor chunk, on top of the above. */
  editor: 200_000,
} as const;

export const gzipSize = (body: Buffer) => gzipSync(body, { level: 9 }).length;

/** What vite.config.ts writes beside the client build: the packages inside each chunk. */
export interface Manifest {
  vendorGroups: Record<string, string>;
  chunks: { file: string; entry: boolean; packages: string[]; app: boolean }[];
}

const manifestPath = join(import.meta.dirname, '../../packages/web/.output/payload-chunks.json');

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null || !('vendorGroups' in value) || !('chunks' in value)) return false;
  const { vendorGroups, chunks } = value;
  return (
    typeof vendorGroups === 'object' &&
    vendorGroups !== null &&
    Object.values(vendorGroups).every((source) => typeof source === 'string') &&
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
    throw new Error('payload-chunks.json is not a manifest: expected vendorGroups and chunks (see packages/web/vite.config.ts)');
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
