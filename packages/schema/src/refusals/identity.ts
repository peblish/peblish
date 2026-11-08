// Owned by lane A: registration, invites and accounts (A01, A03, A05, M20).
export const refusals = {
  'invite.unknown': 'No invite has this code.',
  'invite.expired': 'The invite has passed its expiry.',
  'invite.exhausted': 'The invite has no uses left.',
  'invite.revoked': 'An admin revoked the invite.',
  'registration.capped': 'The beta cap on accounts (site setting registration.cap) is reached.',
  'age.under_16': 'The declared date of birth makes the person younger than 16.',
  'age.declaration_required': 'Sign-up needs a complete, real date of birth to compute the age from.',
  'name.invalid': 'A new local name must match [A-Za-z0-9_]{1,50}.',
  'name.reserved': 'The name is reserved for the instance or its staff.',
  'name.taken': 'A local actor already has this name (case-insensitive).',
  'email.invalid': 'The email address is not one mail can be sent to.',
  'email.taken': 'An account already uses this email address.',
  'password.too_short': 'A password needs at least PASSWORD_MIN (12) characters.',
  'password.too_long': 'A password may have at most PASSWORD_MAX (128) characters.',
  'admin.two_factor_required': 'Admin actions need two-factor authentication turned on (A03).',
  'admin.exists': 'The instance already has a site admin; the bootstrap runs once.',
};
