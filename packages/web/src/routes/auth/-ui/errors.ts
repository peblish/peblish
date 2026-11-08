import type { MessageKey } from '../../../i18n/translate.ts';

// Every code a lane A form can show, each with an error.<code> message in i18n/auth.json:
// the refusal reasons these flows can meet, plus the web-only ones.
export const formErrors = [
  'credentials.invalid',
  'form.invalid',
  'terms.required',
  'invite.unknown',
  'invite.expired',
  'invite.exhausted',
  'invite.revoked',
  'registration.capped',
  'site.disabled',
  'age.under_16',
  'age.declaration_required',
  'name.invalid',
  'name.reserved',
  'name.taken',
  'email.invalid',
  'email.taken',
  'password.too_short',
  'password.too_long',
  'password.wrong',
  'two_factor.invalid_code',
  'two_factor.expired',
  'two_factor.locked',
  'reset.invalid',
  'mail.failed',
  'resend.too_soon',
  'rate.limited',
  'confirm.mismatch',
  'auth.required',
  'auth.admin_required',
  'admin.two_factor_required',
  'target.not_found',
  'target.deleted',
  'target.protected',
  'generic',
  'network',
] as const;

export type FormError = (typeof formErrors)[number];

const known: ReadonlySet<string> = new Set(formErrors);
const isFormError = (code: string): code is FormError => known.has(code);

/** A code from the URL or the server, as one we have a message for. */
export function asFormError(code: string | undefined | null): FormError | undefined {
  if (!code) return undefined;
  return isFormError(code) ? code : 'generic';
}

export const errorKey = (code: FormError): MessageKey<'auth'> => `error.${code}`;
