// Refusals any area may return. Area-specific reasons live in refusals/<area>.ts, owned by
// that area's lane; keys must be unique across all files (checked in refusal.ts).
export const refusals = {
  'auth.required': 'The action needs a signed-in local actor.',
  'auth.admin_required': 'The action needs a local site admin.',
  'site.disabled': 'A site kill switch has turned this feature off.',
  'target.not_found': 'The object the action applies to does not exist here.',
  'target.deleted': 'The object the action applies to has been deleted.',
};
