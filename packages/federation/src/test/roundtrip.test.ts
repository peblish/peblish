import { describe, expect, it } from 'vitest';
import { entityOf, roundTrip } from './corpus.ts';
import { matches } from './diff.ts';
import { readFixture, readManifest } from './manifest.ts';
import { vocabularyByKey } from './vocabulary.ts';

// Every captured wire document maps to its record and back with no difference except the
// documented vocabulary its manifest entry allows. A failure names the entry and the field.

const manifest = readManifest();

describe('every manifest entry round-trips', () => {
  it.each(manifest.entries.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const { mapped, differences } = roundTrip(readFixture(entry.fixture));
    expect(entityOf(mapped)).toBe(entry.entity);
    const allowed = new Set(entry.allowed.map(({ change, path }) => `${change} ${path}`));
    const unexpected = differences
      .filter(({ change, path }) => !allowed.has(`${change} ${path}`))
      .map(({ change, path, original, mapped: back }) => `${change} ${path}: ${JSON.stringify(original)} -> ${JSON.stringify(back)}`);
    expect(unexpected).toEqual([]);
  });
});

it('allows only differences the vocabulary documents', () => {
  const undocumented = manifest.entries.flatMap((entry) =>
    entry.allowed.flatMap(({ path, change, vocabulary }) => {
      const documented = vocabularyByKey.get(vocabulary);
      const ok =
        documented !== undefined && documented.changes.includes(change) && documented.paths.some((pattern) => matches(pattern, path));
      return ok ? [] : [`${entry.id}: ${change} ${path} cites ${vocabulary}`];
    }),
  );
  expect(undocumented).toEqual([]);
});
