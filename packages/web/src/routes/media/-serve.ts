import { findServable } from '@peblish/core/mediascan/serve';

// GET and HEAD /media/<id>: an uploaded image that scanned clean (lane SAFE). Everything else
// (pending, quarantined, blocked, failed, deleted, a malformed or unknown id) is one identical
// 404 that says nothing about which it was. The kill switches are ignored on purpose:
// federation peers fetch these URLs, and a switch is for new traffic, not for images already
// posted. Public and cacheable, so Cloudflare's CSAM tool can see the response (the remote
// proxy is `private` for the opposite reason); a takedown reaches caches within the 5 minutes.

export const MEDIA_MAX_AGE_SECONDS = 300;

/** The one 404, identical for every reason. */
const absent = () =>
  new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

export async function mediaResponse(id: string, request: Pick<Request, 'method' | 'headers'>): Promise<Response> {
  const head = request.method === 'HEAD';
  const image = await findServable(id, { withBody: !head });
  if (!image) return absent();
  const etag = `"${image.sha256}"`;
  const headers = {
    'content-type': image.mimeType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': `public, max-age=${MEDIA_MAX_AGE_SECONDS}`,
    etag,
  };
  if (
    request.headers
      .get('if-none-match')
      ?.split(',')
      .some((tag) => tag.trim() === etag)
  )
    return new Response(null, { status: 304, headers });
  return new Response(head ? null : Buffer.from(image.body ?? new Uint8Array()), {
    status: 200,
    headers: { ...headers, 'content-length': String(image.byteSize) },
  });
}
