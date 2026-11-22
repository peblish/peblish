import { describe, expect, test } from 'vitest';
import { hostileReturns, ordinaryReturns } from '../../server/__fixtures__/return-addresses.ts';
import { reportBack } from './-back.ts';

const origin = 'https://feddit.test';

describe('the report pages keep Cancel and Done on this site', () => {
  test.each([
    ['a tab between the slashes', '/\t//evil.example'],
    ['the encoded tab the review sent', decodeURIComponent('%2F%09%2Fevil.example')],
    ['a line break', '/\n/evil.example'],
    ['two slashes', '//evil.example'],
    ['a backslash', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example/'],
    ...hostileReturns,
  ])('%s: home instead', (_, back) => expect(reportBack(back, origin)).toBe('/'));

  test.each(ordinaryReturns)('%s is kept as given', (back) => expect(reportBack(back, origin)).toBe(back));

  test('a path on this site is kept', () => {
    expect(reportBack('/post/019e0000-0000-7000-8000-000000000000?sort=new#c1', origin)).toBe(
      '/post/019e0000-0000-7000-8000-000000000000?sort=new#c1',
    );
    expect(reportBack(undefined, origin)).toBe('/');
  });
});
