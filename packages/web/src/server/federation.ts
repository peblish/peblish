import { handleFederationRequest, isFederationRequest, negotiatesByAccept } from '@peblish/federation/http';
import { clientIp } from './auth.ts';
import { editable, type Fetch } from './fetch.ts';

/**
 * The address an inbox POST is counted by. A misconfigured PEBLISH_TRUSTED_PROXY throws in
 * clientIp (it fails every sign-in too); an inbox never answers an unexpected 5xx, so here it is
 * logged and federation falls back to the request's own peer.
 */
function inboxPeer(request: Request): string | undefined {
  try {
    return clientIp(request) ?? undefined;
  } catch (error) {
    console.error('federation: the client address could not be resolved', error);
    return undefined;
  }
}

/**
 * Puts federation in front of the UI routes (src/server.ts): its endpoints and the
 * ActivityPub-negotiated page requests go to handleFederationRequest first. A null answer
 * falls through to the UI, which renders the page the path names: a declined GET or HEAD
 * reaches the UI as a request for HTML, since TanStack Start answers 406 to one that does
 * not accept it.
 * An inbox POST is handed the client address web resolves (clientIp: the proxy's header only when
 * PEBLISH_TRUSTED_PROXY names that proxy, otherwise the connection's peer), so the inbox's
 * admission counts the same address the sign-in limits do.
 * Every response on a path that negotiates (`/`, `/u/<name>`, `/c/<name>`), from federation
 * or the UI, says Vary: Accept, so a cache never hands JSON to a browser or HTML to a server.
 */
export function withFederation<O>(ui: Fetch<O>, federation = handleFederationRequest) {
  const route = async (request: Request, opts?: O): Promise<Response> => {
    if (!isFederationRequest(request)) return ui(request, opts);
    const answer = await federation(request, { peer: request.method === 'POST' ? inboxPeer(request) : undefined });
    if (answer) return answer;
    if (request.method !== 'GET' && request.method !== 'HEAD') return ui(request, opts);
    // A fresh Request: the server's own request class cannot be copied with new Request(request).
    const headers = new Headers(request.headers);
    headers.set('accept', 'text/html');
    return ui(new Request(request.url, { method: request.method, headers }), opts);
  };
  return async (request: Request, opts?: O): Promise<Response> => {
    const response = await route(request, opts);
    if (!negotiatesByAccept(new URL(request.url).pathname)) return response;
    if (/(^|,)\s*accept\s*(,|$)/i.test(response.headers.get('vary') ?? '')) return response;
    const varied = editable(response);
    varied.headers.append('Vary', 'Accept');
    return varied;
  };
}
