import { type } from 'arktype';
import { ContentRef, Uuid } from '../ids.ts';

// Owned by lane REP.
const Target = ContentRef.or({ kind: "'actor'", id: Uuid });
const Audience = type("'moderators' | 'admins'");

export const events = {
  'report.created': type({
    type: "'report.created'",
    v: '1',
    reportId: Uuid,
    /** The case number shown as "#N". */
    number: 'number.integer > 0',
    reporterId: Uuid.or('null'),
    communityId: Uuid.or('null'),
    target: Target,
    category: 'string',
    audience: Audience,
    /** True when the reporter asked for the report to be sent to the remote community's moderators. */
    forward: 'boolean',
    /** The Flag's id; set only for a local report that federates. */
    apId: 'string | null',
    local: 'boolean',
  }),
  'report.resolved': type({
    type: "'report.resolved'",
    v: '1',
    target: Target,
    communityId: Uuid.or('null'),
    audience: Audience,
    resolution: "'resolved' | 'dismissed' | 'removed'",
    resolvedBy: Uuid,
    modlogId: Uuid.or('null'),
    reports: type({ id: Uuid, number: 'number.integer > 0', reporterId: Uuid.or('null') }).array(),
  }),
  'report.routed': type({
    type: "'report.routed'",
    v: '1',
    target: Target,
    communityId: Uuid.or('null'),
    to: Audience,
    by: Uuid,
    reportIds: Uuid.array(),
  }),
};
