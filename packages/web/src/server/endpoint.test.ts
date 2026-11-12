import { expect, test } from 'vitest';
import { endpointOf } from './endpoint.ts';

const marker = 'MARKER-typed';
const routeOf = (pathname: string) => (pathname.startsWith('/u/') ? '/u/$handle/' : pathname === '/submit' ? '/submit/' : null);

test('an endpoint is its method and route template, never the path a visitor typed', () => {
  expect(endpointOf(new Request(`https://feddit.test/u/${marker}?q=${marker}`), routeOf)).toBe('GET /u/$handle/');
  expect(endpointOf(new Request('https://feddit.test/submit', { method: 'POST' }), routeOf)).toBe('POST /submit/');
  expect(endpointOf(new Request(`https://feddit.test/_serverFn/${marker}`), routeOf)).toBe('GET server function');
  expect(endpointOf(new Request(`https://feddit.test/${marker}/x/y`), routeOf)).toBe('GET (no route)');
});
