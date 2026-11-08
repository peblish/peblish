import { type } from 'arktype';
import { ContentRef, Uuid } from '../ids.ts';

// Owned by lane REP after G0.
export const events = {
  'report.created': type({
    type: "'report.created'",
    v: '1',
    reportId: Uuid,
    reporterId: Uuid.or('null'),
    communityId: Uuid.or('null'),
    target: ContentRef.or({ kind: "'actor'", id: Uuid }),
    local: 'boolean',
  }),
};
