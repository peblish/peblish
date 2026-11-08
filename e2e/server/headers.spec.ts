import { expect, test } from '@playwright/test';

// The built server's HTML carries the security baseline (packages/web/src/server/headers.ts).
test('HTML pages carry the security headers', async ({ request }) => {
  const headers = (await request.get('/')).headers();
  expect(headers).toMatchObject({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy-report-only': "frame-ancestors 'none'",
  });
  expect(headers['permissions-policy']).toContain('camera=()');
});
