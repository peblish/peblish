import { describe, expect, test } from 'vitest';
import { asResolveError, maxLookupLength } from './outcome.ts';
import { parseLookup } from './parse.ts';

describe('parseLookup', () => {
  test('reads a community handle, a person handle and a bare handle', () => {
    expect(parseLookup('!lab@Lemmy.Test')).toEqual({ kind: 'handle', sigil: '!', name: 'lab', host: 'lemmy.test' });
    expect(parseLookup(' @mira@social.test ')).toEqual({ kind: 'handle', sigil: '@', name: 'mira', host: 'social.test' });
    expect(parseLookup('mira@social.test:8443')).toEqual({ kind: 'handle', sigil: null, name: 'mira', host: 'social.test:8443' });
  });

  test('reads an https link, and nothing else that looks like one', () => {
    expect(parseLookup('https://lemmy.test/post/12')).toEqual({ kind: 'url', url: 'https://lemmy.test/post/12' });
    expect(parseLookup('http://lemmy.test/post/12')).toBeNull();
    expect(parseLookup('ftp://lemmy.test/post/12')).toBeNull();
    expect(parseLookup('https://user:pass@lemmy.test/post/12')).toBeNull();
    expect(parseLookup('https://user@lemmy.test/post/12')).toBeNull();
    expect(parseLookup('javascript:alert(1)')).toBeNull();
  });

  test('refuses empty text, plain words and anything over 500 characters', () => {
    expect(parseLookup('')).toBeNull();
    expect(parseLookup('   ')).toBeNull();
    expect(parseLookup('lemmy')).toBeNull();
    expect(parseLookup('!lab@')).toBeNull();
    expect(parseLookup(`https://lemmy.test/${'a'.repeat(maxLookupLength)}`)).toBeNull();
    expect(parseLookup(`https://lemmy.test/${'a'.repeat(maxLookupLength - 'https://lemmy.test/'.length)}`)).not.toBeNull();
  });
});

test('asResolveError keeps a known code and turns any other into generic', () => {
  expect(asResolveError('target.gone')).toBe('target.gone');
  expect(asResolveError('made.up')).toBe('generic');
  expect(asResolveError(undefined)).toBeUndefined();
  expect(asResolveError('')).toBeUndefined();
});
