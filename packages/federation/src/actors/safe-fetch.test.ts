import { expect, test } from 'vitest';
import { BlockedDestinationError, safeFetch } from './safe-fetch.ts';

// Delete this file when safe-fetch.ts becomes a re-export of lane B2's module, which tests every range.

const init = { schemes: ['https:'], maxRedirects: 0, maxBytes: 1024, timeoutMs: 2000 } as const;

test.each([
  'https://127.0.0.1/inbox',
  'https://10.1.2.3/inbox',
  'https://192.168.0.1/inbox',
  'https://169.254.169.254/latest/meta-data',
  'https://100.64.0.1/inbox',
  'https://[::1]/inbox',
  'https://[::ffff:127.0.0.1]/inbox',
  'https://[fc00::1]/inbox',
  'https://localhost/inbox',
])('a request to %s is refused as a blocked destination', async (url) => {
  await expect(safeFetch(url, init)).rejects.toBeInstanceOf(BlockedDestinationError);
});

test('a scheme outside the list and credentials in the URL are refused', async () => {
  await expect(safeFetch('http://example.com/', init)).rejects.toBeInstanceOf(BlockedDestinationError);
  await expect(safeFetch('https://user:secret@example.com/', init)).rejects.toBeInstanceOf(BlockedDestinationError);
});
