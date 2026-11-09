import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// The payload budget Andrew approved (/Users/admin/Projects/muxui-peblish-rc/PAYLOAD.md,
// "Proposed budget for peblish"). Per route, first visit, bytes transferred (gzip, or woff2 as
// sent), kB of 1000 bytes, excluding app code, the router and the HTML.
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

export function readManifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, '../../packages/web/.output/payload-chunks.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
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
