import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane FED-A, then REM. What federation learns about peers and what the instance does
// about them. A remote actor stored or deleted is actor.created, actor.updated or actor.deleted
// with `local: false` (events/identity.ts); remote content a peer deleted is post.deleted or
// comment.deleted with `local: false` (events/posts.ts, events/comments.ts).
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
  /** Deliveries to the instance failed for the dormancy window and it sent nothing: they are skipped, bar one probe a day. */
  'instance.dormant': type({ type: "'instance.dormant'", v: '1', instanceId: Uuid, domain: 'string' }),
  /** The instance answered again: a delivered probe, or an activity it sent. */
  'instance.revived': type({ type: "'instance.revived'", v: '1', instanceId: Uuid, domain: 'string', by: "'probe' | 'inbound'" }),
  /** A dormant instance was allowed its daily probe delivery. */
  'instance.probed': type({ type: "'instance.probed'", v: '1', instanceId: Uuid, domain: 'string' }),
  /** A run of the backfill of a followed remote community began (attempt counts from 1). */
  'backfill.started': type({ type: "'backfill.started'", v: '1', communityId: Uuid, attempt: 'number.integer' }),
  /** A backfill ended: done (maybe cut short by its caps) or failed for good. */
  'backfill.settled': type({
    type: "'backfill.settled'",
    v: '1',
    communityId: Uuid,
    state: "'done' | 'failed'",
    posts: 'number.integer',
    comments: 'number.integer',
  }),
  /** Old rows of a queue table were deleted (the retention windows are in core/remote/prune.ts). */
  'remote.pruned': type({ type: "'remote.pruned'", v: '1', table: "'inbox_raw' | 'deliveries'", rows: 'number.integer' }),
};
