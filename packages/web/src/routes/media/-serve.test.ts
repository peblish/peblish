import { expect, test, vi } from 'vitest';

const findServable = vi.hoisted(() => vi.fn());
vi.mock('@peblish/core/mediascan/serve', () => ({ findServable }));
const { MEDIA_MAX_AGE_SECONDS, mediaResponse } = await import('./-serve.ts');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const image = { mimeType: 'image/png', sha256: 'ab'.repeat(32), byteSize: png.length, body: png };
const get = (headers: Record<string, string> = {}, method = 'GET') => ({ method, headers: new Headers(headers) });

test('a clean image is served with exactly these headers', async () => {
  findServable.mockResolvedValue(image);
  const response = await mediaResponse('x', get());
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(Object.fromEntries(response.headers)).toEqual({
    'content-type': 'image/png',
    'content-length': String(png.length),
    'cache-control': `public, max-age=${MEDIA_MAX_AGE_SECONDS}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    etag: `"${image.sha256}"`,
  });
  expect(MEDIA_MAX_AGE_SECONDS).toBe(300);
});

test('HEAD has the headers and no body and asks for no object; a matching ETag is a 304', async () => {
  findServable.mockResolvedValue({ ...image, body: null });
  const head = await mediaResponse('x', get({}, 'HEAD'));
  expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, String(png.length), '']);
  expect(findServable).toHaveBeenLastCalledWith('x', { withBody: false });
  findServable.mockResolvedValue(image);
  const cached = await mediaResponse('x', get({ 'if-none-match': `"other", "${image.sha256}"` }));
  expect([cached.status, cached.headers.get('etag')]).toEqual([304, `"${image.sha256}"`]);
});

test('every absence is one identical 404, uncached', async () => {
  findServable.mockResolvedValue(null);
  const answers = await Promise.all(['unknown', 'quarantined', 'pending', 'not-a-uuid'].map((id) => mediaResponse(id, get())));
  const seen = await Promise.all(answers.map(async (r) => [r.status, Object.fromEntries(r.headers), await r.text()]));
  expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(1);
  expect(seen[0]).toEqual([
    404,
    { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    'Not found\n',
  ]);
});
