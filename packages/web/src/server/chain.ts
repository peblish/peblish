import { withClientAborts } from './client-gone.ts';
import { withFederation } from './federation.ts';
import type { Fetch } from './fetch.ts';
import { withSecurityHeaders } from './headers.ts';
import { withRenderCap } from './render-cap.ts';

/**
 * The request handlers around TanStack Start's, outermost first (src/server.ts): client aborts,
 * the security headers, federation, then the cap on signed-out page renders, so only what
 * federation hands to the UI is counted. Here rather than in src/server.ts so tests run the
 * same order.
 */
export const serverChain = <O>(
  start: Fetch<O>,
  federation?: Parameters<typeof withFederation>[1],
  cap?: Parameters<typeof withRenderCap>[1],
) => withClientAborts(withSecurityHeaders(withFederation(withRenderCap(start, cap), federation)));
