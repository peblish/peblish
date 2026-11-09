import { readReportForm, readSentReport } from '@peblish/core/reports/form';
import { Uuid } from '@peblish/schema/ids';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession, principalOf } from '../../server/auth.ts';
import { requestNsfw } from '../c/-gate.ts';

/** The target of a report, as the pages and the dialog name it. */
export const ReportTargetInput = type({ kind: "'post' | 'comment' | 'actor'", id: Uuid });

/**
 * The form for a target: the dialog calls it over fetch, the page's loader on the server. A
 * result, never a throw: signed out is 'auth.required', and a target that is gone or withheld
 * is the policy's refusal. The quote is left out where the post page would gate the content for
 * this viewer and browser (Hide NSFW, from the cookies).
 */
export const loadReportForm = createServerFn({ method: 'GET' })
  .validator(ReportTargetInput)
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (!session) return { ok: false, reason: 'auth.required' } as const;
    return readReportForm(principalOf(session.view), data, undefined, requestNsfw());
  });

/** The sent page's data: the reporter's own report by number, else null (not found). */
export const loadSentReport = createServerFn({ method: 'GET' })
  .validator(type({ number: 'number.integer > 0' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (!session) return { signedOut: true } as const;
    return { signedOut: false, sent: await readSentReport(session.view.actorId, data.number) } as const;
  });
