import { readFileSync } from 'node:fs';
import { Manifest } from './fixtures/manifest.schema.ts';

// Reads the committed corpus: the manifest, and each entry's wire document. The schema keeps
// fixture paths beneath wire/; readFixture checks the resolved file is still there before it
// reads, so a path that slips past the schema reads nothing outside the corpus.

const fixturesDir = new URL('./fixtures/', import.meta.url);
const wireDir = new URL('wire/', fixturesDir);

export function readManifest(): Manifest {
  return Manifest.assert(JSON.parse(readFileSync(new URL('manifest.json', fixturesDir), 'utf8')));
}

export function readFixture(path: string): unknown {
  const url = new URL(path, fixturesDir);
  if (!url.href.startsWith(wireDir.href)) throw new Error(`fixture ${path} resolves outside fixtures/wire/`);
  return JSON.parse(readFileSync(url, 'utf8'));
}
