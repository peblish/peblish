// Owned by lane F: creating and editing local communities, and their moderators (M14).
// Names, admin rights and the shared state guards reuse reasons from the identity, common and
// moderation files (name.invalid, name.reserved, name.taken, auth.admin_required,
// admin.two_factor_required, mod.moderator_required, community.removed, target.banned).
export const refusals = {
  'community.invalid': "A community field is outside its limits (core's CommunityInput: lengths, language codes, at most 15 rules).",
  'community.not_local': 'The community belongs to another instance, so it is edited there, not here.',
  'community.owner_required': "Changing a community's moderators needs its owner or a site admin.",
  'community.role_unchanged': 'The actor already holds this role in the community, or holds none and none was asked for.',
};
