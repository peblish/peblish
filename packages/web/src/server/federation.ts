import { handleFederationRequest, isFederationRequest, negotiatesByAccept } from '@peblish/federation/http';
import { editable, type Fetch } from './fetch.ts';

/**
 * Puts federation in front of the UI routes (src/server.ts): its endpoints and the
 * ActivityPub-negotiated page requests go to handleFederationRequest first, and a null answer
 * falls through to the UI. Pages that negotiate say so (Vary: Accept), so a cache never
 * hands their HTML to a server asking for JSON.
 */
export function withFederation<O>(ui: Fetch<O>, federation = handleFederationRequest) {
  return async (request: Request, opts?: O): Promise<Response> => {
    if (isFederationRequest(request)) {
      const response = await federation(request);
      if (response) return response;
    }
    const response = await ui(request, opts);
    if (!negotiatesByAccept(new URL(request.url).pathname)) return response;
    const varied = editable(response);
    varied.headers.append('Vary', 'Accept');
    return varied;
  };
}
