import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane MODF (wave 3). An admin changed what this server does about one peer.
export const events = {
  /** A peer's controls changed. `purged` is true when the change purged its media (the media setting is then denied). */
  'peer.updated': type({
    type: "'peer.updated'",
    v: '1',
    instanceId: Uuid,
    /** Lowercase host, as in instances.domain. */
    domain: 'string',
    media: "'quarantined' | 'approved' | 'denied'",
    inboxPaused: 'boolean',
    blocked: 'boolean',
    purged: 'boolean',
    modlogId: Uuid,
  }),
};
