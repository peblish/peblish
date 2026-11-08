import { editable, type Fetch } from './fetch.ts';

/**
 * The security baseline on every HTML response (src/server.ts). Lanes extend it here. The
 * CSP is report-only until the pages' sources are known; a route that sets one of these
 * headers itself keeps its own value.
 */
export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy-report-only': "frame-ancestors 'none'",
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
