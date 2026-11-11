import { readReportForm, readSentReport } from '@peblish/core/reports/form';
import { Uuid } from '@peblish/schema/ids';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession, principalOf } from '../../server/auth.ts';
import { requestNsfw } from '../c/-gate.ts';
import { reportBack } from './-back.ts';
import { input } from '../../server/input.ts';

/** The target of a report, as the pages and the dialog name it. */
export const ReportTargetInput = type({ kind: "'post' | 'comment' | 'actor'", id: Uuid });

/** `back` from the page's URL, normalised here on the server, where safeRedirect lives. */
const pageBack = (back: string | undefined) => reportBack(back, new URL(getRequest().url).origin);

/**
 * The form for a target: the dialog calls it over fetch, the page's loader on the server. A
 * result, never a throw: signed out is 'auth.required', and a target that is gone or withheld
 * is the policy's refusal. The quote is left out where the post page would gate the content for
 * this viewer and browser (Hide NSFW, from the cookies). `back` comes back as a safe path on
 * this site for the page's Cancel link.
 */
export const loadReportForm = createServerFn({ method: 'GET' })
  .validator(input(ReportTargetInput.and({ 'back?': 'string' })))
  .handler(async ({ data: { back, ...target } }) => {
    const session = await pageSession();
    if (!session) return { ok: false, reason: 'auth.required', back: pageBack(back) } as const;
    const result = await readReportForm(principalOf(session.view), target, undefined, requestNsfw());
    return { ...result, back: pageBack(back) };
  });

/** The sent page's data: the reporter's own report by number, else null (not found), and the safe `back` for Done. */
export const loadSentReport = createServerFn({ method: 'GET' })
  .validator(input(type({ number: 'number.integer > 0', 'back?': 'string' })))
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (!session) return { signedOut: true } as const;
    return { signedOut: false, sent: await readSentReport(session.view.actorId, data.number), back: pageBack(data.back) } as const;
  });
