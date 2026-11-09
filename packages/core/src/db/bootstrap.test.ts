import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { canonicalOrigin } from '../config.ts';
import { truncateAll } from '../testing/db.ts';
import { ensureLocalInstance } from './bootstrap.ts';
import { localInstance } from './local-instance.ts';
import { db } from './read.ts';
import { writer } from './write.ts';

beforeEach(truncateAll);
afterEach(() => {
  delete process.env.PEBLISH_ALLOW_HTTP_ORIGIN;
});

describe('instance origin', () => {
  test('origins are canonical and HTTPS', () => {
    expect(canonicalOrigin('https://Feddit.COM:443/')).toBe('https://feddit.com');
    expect(canonicalOrigin('https://feddit.test:8443')).toBe('https://feddit.test:8443');
    expect(() => canonicalOrigin('https://feddit.com/sub')).toThrow(/scheme and host only/);
    expect(() => canonicalOrigin('http://feddit.com')).toThrow(/not HTTPS/);
    expect(() => canonicalOrigin('http://g0.peblish.test')).toThrow(/PEBLISH_ALLOW_HTTP_ORIGIN/);
    process.env.PEBLISH_ALLOW_HTTP_ORIGIN = '1';
    expect(canonicalOrigin('http://g0.peblish.test:18300')).toBe('http://g0.peblish.test:18300');
    expect(canonicalOrigin('http://localhost:18300')).toBe('http://localhost:18300');
    expect(() => canonicalOrigin('http://feddit.com')).toThrow(/not HTTPS/);
  });

  test('the full origin is stored and a re-run under another scheme is refused', async () => {
    process.env.PEBLISH_ALLOW_HTTP_ORIGIN = '1';
    await ensureLocalInstance(writer(), 'http://g0.peblish.test:18300');
    expect(await localInstance(db())).toMatchObject({ origin: 'http://g0.peblish.test:18300' });
    await ensureLocalInstance(writer(), 'http://g0.peblish.test:18300/');
    await expect(ensureLocalInstance(writer(), 'https://g0.peblish.test:18300')).rejects.toThrow(
      /local instance is http:\/\/g0.peblish.test:18300/,
    );
  });
});
