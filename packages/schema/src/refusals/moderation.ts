// Owned by lane AZ. Refusals of community moderation (remove, restore, lock, pin, community
// ban) and of the state guards other areas' policies call (authz/state.ts in core).
export const refusals = {
  'mod.moderator_required': "The action needs a moderator or the owner of the community, a site admin, or the owning community's Announce.",
  'mod.announce_mismatch': 'The activity was announced by a community other than the remote community that owns the target.',
  'community.banned': 'The acting actor is banned from the community.',
  'community.removed': 'The community has been removed by a site admin.',
  'community.deleted': 'The community has been deleted.',
  'post.locked': 'The post is locked and takes no new comments.',
  'target.removed': 'The object the action applies to has been removed by a moderator.',
  'target.not_removed': 'The object is not removed, so there is nothing to restore.',
  'target.locked': 'The post is already locked.',
  'target.not_locked': 'The post is not locked.',
  'target.pinned': 'The post is already pinned in its community.',
  'target.not_pinned': 'The post is not pinned in its community.',
  'target.banned': 'The actor is already banned from the community.',
  'target.not_banned': 'The actor is not banned from the community.',
};
