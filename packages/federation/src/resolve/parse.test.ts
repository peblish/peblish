import { parseLookup } from '@peblish/core/resolve/parse';
import { expect, test } from 'vitest';
import { parseHandle } from '../webfinger/client.ts';

// core's parseLookup copies this package's handle grammar; this keeps the two the same.
test('parseLookup reads a handle exactly as parseHandle does', () => {
  const samples = [
    '!lab@lemmy.test',
    '@mira@Social.Test',
    'mira@social.test:8443',
    'acct:mira@social.test',
    '@a.b-c_d@x.test',
    '!@lemmy.test',
    'lab@',
    '@@a@b.test',
    'a b@c.test',
    '!lab@lemmy.test/extra',
    'name@host_with_underscore.test',
  ];
  for (const sample of samples) {
    const handle = parseHandle(sample);
    const lookup = parseLookup(sample);
    if (handle === null) expect(lookup?.kind ?? null, sample).not.toBe('handle');
    else
      expect(lookup, sample).toEqual({
        kind: 'handle',
        sigil: handle.kind === 'Group' ? '!' : handle.kind === 'Person' ? '@' : null,
        name: handle.name,
        host: handle.host,
      });
  }
});
