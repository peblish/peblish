import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane FED-A. Follow state changes. followerLocal and followeeLocal say which side is
// this instance, which is all the delivery consumer needs: it sends a Follow when a local actor
// follows a remote community, an Accept when a remote actor follows a local community, and an
// Undo when a local actor stops following a remote one. `apId` is the Follow activity's id
// (a retried Follow has a fresh one).
const base = {
  v: '1',
  followId: Uuid,
  apId: 'string',
  followerId: Uuid,
  followeeId: Uuid,
  followerLocal: 'boolean',
  followeeLocal: 'boolean',
} as const;

export const events = {
  /** A local actor asked a remote community to follow (pending), or its Follow was sent again. */
  'follow.requested': type({ type: "'follow.requested'", ...base }),
  /** The follow is in force: the remote community accepted, a remote actor followed ours, or a local actor followed a local community. */
  'follow.accepted': type({ type: "'follow.accepted'", ...base }),
  /** The follow ended. `by` is the side that ended it: an unfollow or Undo (follower), or a Reject (followee). */
  'follow.removed': type({ type: "'follow.removed'", ...base, by: "'follower' | 'followee'" }),
};
