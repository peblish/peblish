import { describe, expect, test } from 'vitest';
import { safeRedirect } from './auth.ts';

const origin = 'https://feddit.test';

describe('safeRedirect keeps the visitor on this site', () => {
  test.each([
    ['tab', '/\t/attacker.example'],
    ['carriage return', '/\r/attacker.example'],
    ['line feed', '/\n/attacker.example'],
    ['delete', '/\x7f/attacker.example'],
    ['backslash', '/\\attacker.example'],
    ['protocol-relative', '//attacker.example'],
    ['absolute', 'https://attacker.example/'],
    ['relative', 'attacker.example'],
    ['empty', ''],
  ])('%s: home instead', (_, target) => expect(safeRedirect(target, origin)).toBe('/'));

  test('a path on this site, with its query and fragment', () => {
    expect(safeRedirect('/c/news?sort=new#top', origin)).toBe('/c/news?sort=new#top');
    expect(safeRedirect(undefined, origin)).toBe('/');
  });
});
