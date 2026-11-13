import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane EDGE. What the edge cache's purge path records for operators.
export const events = {
  /**
   * A request to Cloudflare failed (a purge or the idle token check). `failures` counts the
   * failures in a row; `refused` is Cloudflare turning the token or the request down; `why` is
   * the HTTP status and Cloudflare's numeric codes, never the token. `actorId` is the instance
   * actor the worker acts as.
   */
  'edge.purge_failed': type({
    type: "'edge.purge_failed'",
    v: '1',
    actorId: Uuid,
    failures: 'number.integer >= 1',
    refused: 'boolean',
    why: 'string <= 200',
  }),
};
