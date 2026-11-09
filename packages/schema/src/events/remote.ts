import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane FED-A (REM inherits it). What federation learns about peers. A remote actor
// stored or deleted is actor.created, actor.updated or actor.deleted with `local: false`
// (events/identity.ts).
export const events = {
  /** A peer's NodeInfo software changed (or the instance was first seen with one). */
  'instance.updated': type({
    type: "'instance.updated'",
    v: '1',
    instanceId: Uuid,
    /** Lowercase host, as in instances.domain. */
    domain: 'string',
    /** NodeInfo's software name, lowercase (lemmy, piefed, mastodon); null when it could not be read. */
    software: 'string | null',
    softwareVersion: 'string | null',
  }),
};
