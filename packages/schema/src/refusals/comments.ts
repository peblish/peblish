// Owned by lane D: refusals of the comment policies (authz/actions/comments.ts in core). The
// refusals a comment action shares with others (post.locked, target.deleted, target.removed,
// community.banned, auth.email_unverified) live in their own areas' files.
export const refusals = {
  'comment.depth_exceeded': 'The comment replied to is already at the deepest level a thread has (50 levels), so it takes no reply.',
  'comment.group_cannot_act': 'A community (a Group) does not comment: the acting remote actor is not a person.',
  'comment.author_required': "Only the comment's author may edit, delete or restore it.",
  'comment.not_deleted': 'The comment is not deleted, so there is nothing to restore.',
};
