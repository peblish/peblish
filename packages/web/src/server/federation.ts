import { handleFederationRequest, isFederationRequest, negotiatesByAccept } from '@peblish/federation/http';
import { editable, type Fetch } from './fetch.ts';

/**
 * Puts federation in front of the UI routes (src/server.ts): its endpoints and the
 * ActivityPub-negotiated page requests go to handleFederationRequest first. A null answer
 * falls through to the UI, which renders the page the path names: a declined GET or HEAD
 * reaches the UI as a request for HTML, since TanStack Start answers 406 to one that does
 * not accept it.
 * Every response on a path that negotiates (`/`, `/u/<name>`, `/c/<name>`), from federation
 * or the UI, says Vary: Accept, so a cache never hands JSON to a browser or HTML to a server.
 */
export function withFederation<O>(ui: Fetch<O>, federation = handleFederationRequest) {
  const route = async (request: Request, opts?: O): Promise<Response> => {
    if (!isFederationRequest(request)) return ui(request, opts);
    const answer = await federation(request);
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
