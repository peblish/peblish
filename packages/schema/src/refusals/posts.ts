// Owned by lane B1: refusals of the post policies (authz/actions/posts.ts in core). The
// refusals a post action shares with others (target.deleted, target.removed, community.banned,
// auth.email_unverified) live in their own areas' files.
export const refusals = {
  'community.posting_restricted':
    "The community only lets its moderators and owner, and site admins, post (the community's posting_restricted_to_mods setting).",
  'post.author_required': "Only the post's author may edit, delete or restore it.",
  'post.group_cannot_act':
    'A community (a Group actor) does not author, edit or vote on posts; the people in it do, relayed by its Announce.',
  'post.id_conflict': 'This ActivityPub id names a post that exists under a different id, author or community.',
  'post.not_deleted': 'The post is not deleted, so there is nothing to restore.',
};
