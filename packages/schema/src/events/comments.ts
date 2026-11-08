import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane D after G0.
const base = {
  v: '1',
  commentId: Uuid,
  postId: Uuid,
  authorId: Uuid,
  local: 'boolean',
} as const;

export const events = {
  'comment.created': type({ type: "'comment.created'", ...base, parentId: Uuid.or('null') }),
  'comment.updated': type({ type: "'comment.updated'", ...base }),
  'comment.deleted': type({ type: "'comment.deleted'", ...base }),
};
