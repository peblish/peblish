import { expect, test } from '@playwright/test';

// The built server's HTML carries the security baseline (packages/web/src/server/headers.ts).
test('HTML pages carry the security headers', async ({ request }) => {
  const headers = (await request.get('/')).headers();
  expect(headers).toMatchObject({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    // Enforced: a report-only frame-ancestors does not stop framing.
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  expect(headers['content-security-policy-report-only']).toContain("default-src 'self'");
  expect(headers['permissions-policy']).toContain('camera=()');
});
