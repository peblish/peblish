import type { MessageKey } from '../../i18n/translate.ts';

// The refusals the community pages and forms can come back with (?error=<reason> or a JSON
// { error }), each with its message in communities.json as `error.<reason>`; anything else is the generic one.
const reasons = new Set([
  'auth.required',
  'auth.admin_required',
  'admin.two_factor_required',
  'community.invalid',
  'community.not_local',
  'community.owner_required',
  'community.removed',
  'community.deleted',
  'community.banned',
  'mod.moderator_required',
  'name.invalid',
  'name.reserved',
  'name.taken',
  'target.not_found',
]);

export const errorKey = (reason: string | undefined): MessageKey<'communities'> =>
  reason !== undefined && reasons.has(reason) ? (`error.${reason}` as MessageKey<'communities'>) : 'error.generic';
