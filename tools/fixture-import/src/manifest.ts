import { basename } from 'node:path';
import { entityOf, explain, roundTrip, shapeOf } from '@peblish/federation/test/corpus';
import type { Manifest, ManifestEntry } from '@peblish/federation/test/fixtures/manifest.schema';
import type { Candidate } from './captures.ts';

export type BuiltManifest = {
  manifest: Manifest;
  /** Wire documents to commit, by path relative to the fixtures directory. */
  files: Map<string, unknown>;
  /** Round-trip differences no vocabulary entry documents: the build refuses to write when there are any. */
  undocumented: string[];
};

const slug = (shape: string) => shape.replaceAll(/[()]+/g, '-').replace(/-$/, '').toLowerCase();

/** One manifest entry per candidate, with the differences its round trip shows, each tied to its vocabulary entry. */
export function buildManifest(candidates: Candidate[]): BuiltManifest {
  const files = new Map<string, unknown>();
  const undocumented: string[] = [];
  const entries: ManifestEntry[] = candidates.map((candidate) => {
    const shape = shapeOf(candidate.json);
    const stem = basename(candidate.source.file, '.jsonl');
    const id = `${candidate.software.name}-${candidate.software.version}/${candidate.direction}/${stem}-${String(candidate.source.line).padStart(4, '0')}-${slug(shape)}`;
    const fixture = `wire/${id}.json`;
    files.set(fixture, candidate.json);
    const { mapped, differences } = roundTrip(candidate.json);
    const allowed = differences.flatMap((difference) => {
      const vocabulary = explain(difference);
      if (vocabulary === undefined) {
        undocumented.push(`${id}: ${difference.change} ${difference.path}`);
        return [];
      }
      return [{ path: difference.path, change: difference.change, vocabulary }];
    });
    return {
      id,
      software: candidate.software,
      type: shape,
      direction: candidate.direction,
      source: candidate.source,
      fixture,
      entity: entityOf(mapped),
      allowed,
    };
  });
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { manifest: { version: '1', entries }, files, undocumented };
}
