import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane B2. Lane SAFE consumes media.stored to scan the object and move the row out
// of scan_state 'pending'; nothing serves a media row before that.
export const events = {
  /** A cleaned image was stored and its media row inserted, scan_state 'pending'. */
  'media.stored': type({ type: "'media.stored'", v: '1', mediaId: Uuid, ownerId: Uuid, kind: "'upload' | 'thumbnail'" }),
};
