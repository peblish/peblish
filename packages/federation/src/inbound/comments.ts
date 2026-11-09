import type { Tx } from '@peblish/core/tx/tx';
import type { CommentRecord } from '../mapping/records.ts';
import type { Stored } from './authorize.ts';
import type { InboundContext } from './handler.ts';
import { skip } from './reasons.ts';

// The seam to lane D's comment mutations (packages/core/src/comments/). Lane D builds them in
// parallel, so the handlers for a Note call this interface and it answers
// `comments.unavailable` until root wires it at integration: LANE-NOTES.md (section 5) has the
// exact body, which authorizes comment.create, comment.update and comment.delete as the remote
// principal (principalOf, via grantFor) and calls D's remote counterparts with .within(t, ...).
// The tests replace these members with vi.spyOn; nothing else in the pipeline knows about D.

export interface CommentMutations {
  /** Create(Note): stores a peer's comment under `parent`, the post or comment it replies to. */
  create(ctx: InboundContext, t: Tx, comment: CommentRecord, parent: Stored): Promise<{ created: boolean }>;
  /** Update(Note) by the author: replaces the comment's editable fields. */
  update(ctx: InboundContext, t: Tx, comment: CommentRecord, existing: Stored): Promise<void>;
  /** The author's Delete of the comment. */
  delete(ctx: InboundContext, t: Tx, existing: Stored): Promise<void>;
}

const unavailable = async (): Promise<never> => {
  throw skip('comments.unavailable');
};

export const comments: CommentMutations = { create: unavailable, update: unavailable, delete: unavailable };
