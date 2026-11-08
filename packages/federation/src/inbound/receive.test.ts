import { expect, test } from 'vitest';
import { receiveInbound } from './receive.ts';

test('until the pipeline lands, an inbox POST is answered 503 with Retry-After', async () => {
  const request = new Request('https://root.peblish.test/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/activity+json' },
    body: JSON.stringify({ type: 'Follow' }),
  });
  const response = await receiveInbound(request);
  expect({ status: response.status, retryAfter: response.headers.get('retry-after') }).toEqual({ status: 503, retryAfter: '300' });
});
