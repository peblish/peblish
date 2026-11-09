// Owned by lane REP (wave 3). Reports share target.not_found, target.deleted, target.removed,
// target.protected, community.deleted, community.removed, community.banned, auth.required,
// auth.admin_required and mod.moderator_required with other areas.
export const refusals = {
  'report.self': 'A person cannot report their own post, comment or account.',
  'report.category_invalid': 'The category is not one a report about this kind of target may use.',
  'report.reason_required': 'The details are required (the category other, a removal explanation) or longer than the limit.',
  'report.forward_unavailable': 'The report cannot be sent to another instance: its category stays here, or no remote recipient exists.',
  'report.duplicate': 'The reporter already has an open report about this target.',
  'report.not_open': 'No open report matches: it was resolved, dismissed or routed already.',
  'report.admin_only': 'The reports are for the instance admins and cannot be routed to community moderators.',
  'report.not_content': 'A removal needs a post or comment; a report about a person or community is resolved without one.',
};
