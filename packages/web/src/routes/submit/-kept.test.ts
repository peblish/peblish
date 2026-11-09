import { expect, test } from 'vitest';
import { decodeKept, encodeKept, keptBodyMaxLength } from './-kept.ts';

test('what was typed comes back, including text a URL would mangle', () => {
  const fields = {
    community: '0192f5a0-1234-7abc-8def-0123456789ab',
    type: 'link',
    title: 'Ünï 日本語 "quotes" & 100%?',
    url: 'https://x.test/a?b=1',
    nsfw: true,
  } as const;
  expect(decodeKept(encodeKept({ ...fields, body: '# heading\n\n+ plus / slash' }))).toEqual({
    ...fields,
    body: '# heading\n\n+ plus / slash',
  });
});

test('a body too long for a URL is left out, and anything that is not ours is ignored', () => {
  expect(decodeKept(encodeKept({ title: 'kept', body: 'x'.repeat(keptBodyMaxLength + 1) }))).toEqual({ title: 'kept' });
  for (const junk of [undefined, '', 'not base64!', btoa('{"title":5}'), btoa('[]')]) expect(decodeKept(junk)).toBeUndefined();
});
