import { expect, test } from 'vitest';
import { endpointOf } from './endpoint.ts';

const marker = 'MARKER-typed';
const routeOf = (pathname: string) => (pathname.startsWith('/u/') ? '/u/$handle/' : pathname === '/submit' ? '/submit/' : null);
const registered: Record<string, string> = { aaa: 'loadProfile', bbb: 'getRootData' };
const functionOf = async (id: string) => registered[id] ?? null;

test('an endpoint is its method and route template, never the path a visitor typed', async () => {
  expect(await endpointOf(new Request(`https://feddit.test/u/${marker}?q=${marker}`), routeOf, functionOf)).toBe('GET /u/$handle/');
  expect(await endpointOf(new Request('https://feddit.test/submit', { method: 'POST' }), routeOf, functionOf)).toBe('POST /submit/');
  expect(await endpointOf(new Request(`https://feddit.test/${marker}/x/y`), routeOf, functionOf)).toBe('GET (no route)');
});

test('a server function is named by the build’s registry for an id it holds, and by a fixed label otherwise', async () => {
  expect(await endpointOf(new Request('https://feddit.test/_serverFn/aaa'), routeOf, functionOf)).toBe('GET server function loadProfile');
  expect(await endpointOf(new Request('https://feddit.test/_serverFn/bbb', { method: 'POST' }), routeOf, functionOf)).toBe(
    'POST server function getRootData',
  );
  expect(await endpointOf(new Request(`https://feddit.test/_serverFn/${marker}`), routeOf, functionOf)).toBe(
    'GET server function (unregistered)',
  );
  // A lookup that throws, or a registry name that is not an identifier, is the fixed label too.
  const throwing = async () => Promise.reject(new Error(marker));
  expect(await endpointOf(new Request('https://feddit.test/_serverFn/aaa'), routeOf, throwing)).toBe('GET server function (unregistered)');
  expect(await endpointOf(new Request('https://feddit.test/_serverFn/aaa'), routeOf, async () => `x ${marker}`)).toBe(
    'GET server function (unregistered)',
  );
});
