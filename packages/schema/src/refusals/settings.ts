// Owned by lane ADM (wave 3): site settings and the CMS pages. A page that does not exist is
// target.not_found; a settings or page action by anyone but an admin with two-factor gets
// auth.required, auth.admin_required or admin.two_factor_required.
export const refusals = {
  'settings.invalid': "A setting key is unknown, or its value does not meet that key's contract (type, length, format).",
  'page.invalid': 'A page title or body is empty, too long or not text.',
  'page.unresolved_tokens': 'The page still holds a {{TOKEN}} or an operator setting it needs is empty, so it cannot be published.',
  'page.not_published': 'The page has no published revision to unpublish.',
};
