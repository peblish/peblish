import { expect, test } from 'vitest';
import { hostFrom } from './-act.ts';

test('a host is read from a bare host or a pasted address, in lower case', () => {
  expect(hostFrom('Lemmy.World')).toBe('lemmy.world');
  expect(hostFrom('  https://Lemmy.World/c/news ')).toBe('lemmy.world');
  expect(hostFrom('lemmy.world:8443')).toBe('lemmy.world:8443');
  expect(hostFrom('not a host')).toBe('not a host');
});
