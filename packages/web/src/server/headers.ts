import { editable, type Fetch } from './fetch.ts';

/**
 * The security baseline on every HTML response (src/server.ts). Lanes extend it here. A route
 * that sets one of these headers itself keeps its own value.
 *
 * Framing is refused for real: browsers ignore frame-ancestors in a report-only policy, so
 * it is enforced on its own, with X-Frame-Options for browsers that predate it. The fuller
 * policy stays report-only until the pages' script, style and media sources are known.
 */
export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'content-security-policy-report-only': "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function withSecurityHeaders<O>(next: Fetch<O>) {
  return async (request: Request, opts?: O): Promise<Response> => {
    const response = await next(request, opts);
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
    const secured = editable(response);
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (!secured.headers.has(name)) secured.headers.set(name, value);
    }
    return secured;
  };
}
