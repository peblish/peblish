// Report-only bundle size table for the web client (CI writes it to the job summary).
// Enforcement waits for the Mux payload budget Andrew approves (plan decision 11).
import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const assets = join(import.meta.dirname, '../packages/web/.output/public');
const files = globSync('**/*.{js,css,woff,woff2,ttf,otf}', { cwd: assets });
if (files.length === 0) throw new Error(`no client assets under ${assets}: run pnpm build first`);

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
const rows = files
  .map((file) => {
    const body = readFileSync(join(assets, file));
    return { file, kind: file.split('.').pop() ?? '', raw: statSync(join(assets, file)).size, gzip: gzipSync(body).length };
  })
  .sort((a, b) => b.raw - a.raw);

const total = (kinds: string[]) =>
  rows
    .filter(({ kind }) => kinds.includes(kind))
    .reduce((sum, { raw, gzip }) => ({ raw: sum.raw + raw, gzip: sum.gzip + gzip }), { raw: 0, gzip: 0 });
const lines = ['## Web bundle (report only)', '', '| Asset | Raw | Gzip |', '| --- | ---: | ---: |'];
for (const [label, kinds] of [
  ['All JavaScript', ['js']],
  ['All CSS', ['css']],
  ['All fonts', ['woff', 'woff2', 'ttf', 'otf']],
] as const) {
  const sum = total([...kinds]);
  lines.push(`| **${label}** | ${kb(sum.raw)} | ${kb(sum.gzip)} |`);
}
for (const { file, raw, gzip } of rows.slice(0, 15)) lines.push(`| ${file} | ${kb(raw)} | ${kb(gzip)} |`);
console.log(lines.join('\n'));
