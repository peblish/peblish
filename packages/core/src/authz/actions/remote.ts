import type { SystemJob } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { allow, deny, type PolicyRequest } from '../policy.ts';

// Owned by lane FED-A, then REM. What federation records about peers is written by the instance
// itself, never on a person's behalf: while importing a document it fetched and checked
// (systemPrincipal 'import'), or from a scheduled job ('scheduled'). No row a policy reads is
// updated by its write, so there is nothing to lock.

const asSystem =
  (job: SystemJob) =>
  ({ principal }: PolicyRequest<unknown>) =>
    principal.kind === 'system' && principal.job === job
      ? allow({ kind: 'system', actorId: principal.actorId, job, ref: null })
      : deny('auth.required');

const importer = asSystem('import');
const scheduled = asSystem('scheduled');

export const policies = {
  /** Upsert a remote actor (and its public key) from a fetched document. The subject names the document's id. */
  'remote.actor_store': async (request: PolicyRequest<{ apId: string }>) => importer(request),
  /** A remote actor's own Delete, or its refetched 410 or Tombstone: soft delete and scrub, keeping the ap_id and key. */
  'remote.actor_delete': async (request: PolicyRequest<{ apId: string }>) => importer(request),
  /** An actor that was deleted answers with a valid document again (an undone Delete, a mistaken 410). */
  'remote.actor_undelete': async (request: PolicyRequest<{ apId: string }>) => importer(request),
  /** A remote post or comment that its own server now answers with 410 or a Tombstone. */
  'remote.object_delete': async (request: PolicyRequest<{ apId: string }>) => importer(request),
  /** Record the software a peer's NodeInfo names. The subject names the peer's origin. */
  'remote.instance_store': async (request: PolicyRequest<{ origin: string }>) => importer(request),
  /** The health job marks an instance dormant, or alive again. */
  'remote.instance_health': async (request: PolicyRequest<{ instanceId: Uuid }>) => scheduled(request),
  /** The delivery worker asks whether a dormant instance may have its daily probe. */
  'remote.instance_probe': async (request: PolicyRequest<{ instanceId: Uuid }>) => scheduled(request),
  /** The backfill job takes the next due community. */
  'remote.backfill_claim': async (request: PolicyRequest<Record<string, never>>) => scheduled(request),
  /** The backfill job records how its run ended. */
  'remote.backfill_settle': async (request: PolicyRequest<{ communityId: Uuid }>) => scheduled(request),
  /** The retention job deletes old rows of one queue or bookkeeping table. */
  'remote.prune': async (request: PolicyRequest<{ table: 'inbox_raw' | 'deliveries' | 'inbox_dedupe' | 'throttles' }>) =>
    scheduled(request),
};
