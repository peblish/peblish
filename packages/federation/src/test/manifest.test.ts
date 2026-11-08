import { type } from 'arktype';
import { describe, expect, it } from 'vitest';
import { FixturePath } from './fixtures/manifest.schema.ts';
import { readFixture, readManifest } from './manifest.ts';

const escapes = [
  '../../../../package.json',
  'wire/../../../../package.json',
  'wire/%2e%2e/%2e%2e/manifest.json',
  'wire\\..\\..\\manifest.json',
  '/etc/passwd',
  'file:///etc/passwd',
  'https://example.org/wire/a.json',
];

describe('fixture paths', () => {
  it('accepts every committed entry and refuses traversal, absolute URLs and backslashes', () => {
    for (const entry of readManifest().entries) expect(FixturePath(entry.fixture)).toBe(entry.fixture);
    for (const path of escapes) expect(FixturePath(path), path).toBeInstanceOf(type.errors);
  });

  it('reads nothing outside fixtures/wire/ even when a path gets past the schema', () => {
    expect(() => readFixture('../../../../package.json')).toThrow('resolves outside fixtures/wire/');
    expect(() => readFixture('file:///etc/passwd')).toThrow('resolves outside fixtures/wire/');
    expect(() => readFixture('wire/../manifest.json')).toThrow('resolves outside fixtures/wire/');
  });
});
