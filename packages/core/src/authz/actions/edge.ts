import { allow, deny, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane EDGE. The worker paying the edge cache's purge debt (edge/send.ts), as the
// instance itself (systemPrincipal 'scheduled'). The rows it claims and settles are its own
// queue and the readiness record; no policy reads them, so there is nothing to lock.

const scheduled = ({ principal }: PolicyRequest<unknown>): PolicyResult =>
  principal.kind === 'system' && principal.job === 'scheduled'
    ? allow({ kind: 'system', actorId: principal.actorId, job: 'scheduled', ref: null })
    : deny('auth.required');

export const policies = {
  /** Takes the next batch of due purges (or the idle check) under a lease, if the shared rate allows. */
  'edge.purge_claim': async (request: PolicyRequest<Record<string, never>>) => scheduled(request),
  /** Records a batch's result: settles exactly the rows it took, or gives them back. */
  'edge.purge_settle': async (request: PolicyRequest<{ token: string }>) => scheduled(request),
};
