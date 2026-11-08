import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readCandidates } from './captures.ts';
import { writeJson } from './format.ts';
import { buildLabLive } from './lab-live.ts';
import { buildManifest } from './manifest.ts';
import { coreSetsDir, defaultCapturesDir, federationFixturesDir } from './paths.ts';
import { findSecrets } from './secrets.ts';

// node tools/fixture-import/src/cli.ts build [--captures <dir>]
//   Rebuilds packages/federation/src/test/fixtures/{manifest.json,wire/} and the lab-live
//   fixture set from the spike captures. Refuses when a round trip shows a difference the
//   vocabulary does not document, or when any output would hold a secret.
// node tools/fixture-import/src/cli.ts archive
//   Reads the archive subset from FEDDIT_ARCHIVE_DB_URL, runs the same round trip and prints
//   the schema deltas table. Writes nothing.

const usage = 'usage: node tools/fixture-import/src/cli.ts build [--captures <dir>] | archive';
const { positionals, values } = parseArgs({ allowPositionals: true, options: { captures: { type: 'string' } } });

async function build(capturesDir: string): Promise<number> {
  const candidates = readCandidates(capturesDir);
  const { manifest, files, undocumented } = buildManifest(candidates);
  if (undocumented.length > 0) {
    console.error(
      `undocumented round-trip differences (document them in packages/federation/src/test/vocabulary.ts or fix the mapping):\n${undocumented.join('\n')}`,
    );
    return 1;
  }
  const { set, dropped } = buildLabLive(candidates);
  const secrets = [...[...files].flatMap(([path, json]) => findSecrets(json, path)), ...findSecrets(set, 'lab-live')];
  if (secrets.length > 0) {
    console.error(`refusing to write secrets:\n${secrets.join('\n')}`);
    return 1;
  }
  rmSync(join(federationFixturesDir, 'wire'), { recursive: true, force: true });
  for (const [path, json] of files) await writeJson(join(federationFixturesDir, path), json);
  await writeJson(join(federationFixturesDir, 'manifest.json'), manifest);
  await writeJson(join(coreSetsDir, 'lab-live.json'), set);
  const counts = new Map<string, number>();
  for (const entry of manifest.entries) {
    const key = `${entry.software.name} ${entry.software.version} ${entry.direction}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`manifest: ${manifest.entries.length} entries`);
  for (const [key, count] of [...counts].sort()) console.log(`  ${count}\t${key}`);
  console.log(
    `lab-live: ${set.instances.length} instances, ${set.actors.length} actors, ${set.posts.length} posts, ${set.comments.length} comments, ${set.votes.length} votes, ${set.follows.length} follows`,
  );
  for (const line of dropped) console.log(`  left out: ${line}`);
  return 0;
}

async function main(): Promise<number> {
  const [command] = positionals;
  if (command === 'build') return build(values.captures ?? process.env.FIXTURE_CAPTURES_DIR ?? defaultCapturesDir);
  if (command === 'archive') {
    const url = process.env.FEDDIT_ARCHIVE_DB_URL;
    if (!url) {
      console.error('FEDDIT_ARCHIVE_DB_URL is unset: point it at the restored PieFed archive (peblish_fit_archive)');
      return 1;
    }
    const { runArchive, deltasTable } = await import('./archive.ts');
    const report = await runArchive(url);
    console.log(deltasTable(report));
    if (report.undocumented.length > 0) {
      console.error(`undocumented differences:\n${report.undocumented.join('\n')}`);
      return 1;
    }
    return 0;
  }
  console.error(usage);
  return 64;
}

process.exitCode = await main();
