import type { MessageKey } from '../../../i18n/translate.ts';

// Every code the report form and the queue can show, each with an error.<code> message in
// i18n/reports.json: the refusal reasons these flows meet, plus the web-only ones.
export const reportErrors = [
  'category.required',
  'details.required',
  'details.too_long',
  'report.self',
  'report.duplicate',
  'report.forward_unavailable',
  'report.not_open',
  'report.admin_only',
  'report.reason_required',
  'report.not_content',
  'community.banned',
  'community.removed',
  'community.deleted',
  'target.not_found',
  'target.deleted',
  'target.removed',
  'auth.required',
  'auth.admin_required',
  'mod.moderator_required',
  'rate.limited',
  'form.invalid',
  'generic',
  'network',
] as const;

export type ReportError = (typeof reportErrors)[number];

const known: ReadonlySet<string> = new Set(reportErrors);
const isReportError = (code: string): code is ReportError => known.has(code);

/** A code from the URL or the server, as one we have a message for. */
export function asReportError(code: string | undefined | null): ReportError | undefined {
  if (!code) return undefined;
  return isReportError(code) ? code : 'generic';
}

export const errorKey = (code: ReportError): MessageKey<'reports'> => `error.${code}`;
