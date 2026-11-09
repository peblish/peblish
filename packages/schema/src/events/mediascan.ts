import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane SAFE (wave 3). Scanning, quarantine, review and the blocked-image list. Events
// carry ids and states only: never a hash of a quarantined image beyond what the list holds.
const state = "'pending' | 'clean' | 'quarantined' | 'blocked' | 'failed'";

export const events = {
  /** The scanner (or the undecided-window expiry) moved a media row from one state to another, other than into quarantine. */
  'media.scanned': type({ type: "'media.scanned'", v: '1', mediaId: Uuid, from: state, to: state }),
  /** A media row was quarantined: a list or provider match, or a hash added to the list that a clean image carries. */
  'media.quarantined': type({
    type: "'media.quarantined'",
    v: '1',
    mediaId: Uuid,
    evidenceId: Uuid,
    source: "'provider' | 'list'",
    classification: 'string',
    from: state,
  }),
  /** The stored bytes of a media row are gone and its storage key cleared. */
  'media.purged': type({ type: "'media.purged'", v: '1', mediaId: Uuid, cause: "'blocked' | 'failed'" }),
  /** An admin decided a quarantined image, or recorded a hold on it. */
  'media.reviewed': type({
    type: "'media.reviewed'",
    v: '1',
    mediaId: Uuid,
    evidenceId: Uuid,
    adminId: Uuid,
    decision: "'confirmed' | 'released' | 'held'",
  }),
  /** A hash was added to or removed from the blocked-image list. `quarantined` counts the clean copies an addition caught. */
  'media.blocklist_changed': type({
    type: "'media.blocklist_changed'",
    v: '1',
    entryId: Uuid,
    adminId: Uuid,
    change: "'added' | 'removed'",
    quarantined: 'number.integer >= 0',
  }),
};
