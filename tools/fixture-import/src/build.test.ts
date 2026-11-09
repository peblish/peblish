import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCandidates } from './captures.ts';
import { formatJson } from './format.ts';
import { buildLabLive } from './lab-live.ts';
import { buildManifest } from './manifest.ts';
import { coreSetsDir, defaultCapturesDir, federationFixturesDir } from './paths.ts';

// The committed corpus is exactly what the tool builds from the captures. The captures are
// gitignored (only the maintainer's checkout has them), so this skips elsewhere; point
// FIXTURE_CAPTURES_DIR at them to run it from a worktree.
const captures = process.env.FIXTURE_CAPTURES_DIR ?? defaultCapturesDir;

describe.skipIf(!existsSync(captures))('fixture build', () => {
  it('rebuilds the committed manifest, wire documents and lab-live set byte for byte', async () => {
    const candidates = readCandidates(captures);
    const { manifest, files, undocumented } = buildManifest(candidates);
    expect(undocumented).toEqual([]);
    const committed = globSync('wire/**/*.json', { cwd: federationFixturesDir }).sort();
    expect([...files.keys()].sort()).toEqual(committed);
    for (const [path, json] of files) expect(readFileSync(join(federationFixturesDir, path), 'utf8'), path).toBe(await formatJson(json));
    expect(readFileSync(join(federationFixturesDir, 'manifest.json'), 'utf8')).toBe(await formatJson(manifest));
    expect(readFileSync(join(coreSetsDir, 'lab-live.json'), 'utf8')).toBe(await formatJson(buildLabLive(candidates).set));
  });
});
