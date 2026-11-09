import { allow, deny, type PolicyRequest } from '../policy.ts';

// Owned by lane FED-A (REM inherits it). What federation records about peers is written by
// the instance itself while it imports a document (systemPrincipal 'import'), never on a
// person's behalf: the document was fetched and checked by the federation package before any
// of these runs. No row a policy reads is updated by its write, so there is nothing to lock.

const importer = (principal: PolicyRequest<unknown>['principal']) =>
  principal.kind === 'system' && principal.job === 'import'
    ? allow({ kind: 'system', actorId: principal.actorId, job: 'import', ref: null })
    : deny('auth.required');

export const policies = {
  /** Upsert a remote actor (and its public key) from a fetched document. The subject names the document's id. */
  'remote.actor_store': async ({ principal }: PolicyRequest<{ apId: string }>) => importer(principal),
  /** A remote actor's own Delete: soft delete and scrub, keeping the ap_id and key. */
  'remote.actor_delete': async ({ principal }: PolicyRequest<{ apId: string }>) => importer(principal),
  /** Record the software a peer's NodeInfo names. The subject names the peer's origin. */
  'remote.instance_store': async ({ principal }: PolicyRequest<{ origin: string }>) => importer(principal),
};
