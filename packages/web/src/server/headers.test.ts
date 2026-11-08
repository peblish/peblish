import { expect, test } from 'vitest';
import { securityHeaders, withSecurityHeaders } from './headers.ts';

const respond = (contentType: string, headers: Record<string, string> = {}) =>
  withSecurityHeaders(async () => new Response('body', { headers: { 'content-type': contentType, ...headers } }));
const request = new Request('https://feddit.test/');

test('HTML responses get the baseline', async () => {
  const response = await respond('text/html; charset=utf-8')(request);
  for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name)).toBe(value);
  expect(await response.text()).toBe('body');
});

test('other responses are left alone, and a route keeps its own value', async () => {
  expect((await respond('application/json')(request)).headers.get('x-content-type-options')).toBeNull();
  const own = await respond('text/html', { 'referrer-policy': 'no-referrer' })(request);
  expect(own.headers.get('referrer-policy')).toBe('no-referrer');
});
