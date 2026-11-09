import { auth } from '@peblish/core/identity/auth';
import { parseNsfwChoice, type NsfwChoice } from '@peblish/core/communities/gate';
import { appendResponseHeader, getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { ageGated } from '../../server/auth.ts';
import type { GateData } from './-ui/gate.tsx';

// What the gated pages (community, post, comment permalink) share on the server: the browser's
// Hide NSFW choice from its cookies, and the gate-only payload. A gate answers 200 with
// noindex and, through pageSession, private no-store; nothing but the community's handle is in it.

/** The Hide NSFW cookies of the request being served (a loader or server function). */
export const requestNsfw = (): NsfwChoice => parseNsfwChoice(getRequest().headers.get('cookie'));

/** Whether the NSFW cookies carry Secure: when better-auth's own cookies do (an https instance origin). */
export async function secureCookies(): Promise<boolean> {
  const { authCookies } = await (await auth()).$context;
  return !!authCookies.sessionToken.attributes.secure;
}

/**
 * The gate payload for a page that core withheld. `gate` is core's answer for this viewer; an
 * undeclared viewer whose browser answered "under 16" in the last 24 hours gets no form.
 */
export function gateData(options: {
  subject: GateData['subject'];
  gate: 'sign-in' | 'age' | 'hidden';
  handle: string;
  back: string;
}): GateData {
  const { gate, ...rest } = options;
  setResponseHeader('x-robots-tag', 'noindex');
  const state = gate === 'age' && ageGated(getRequest()) ? 'under-16' : gate;
  return { kind: 'gate', state, ...rest };
}

/**
 * Says `Vary: Accept` for a page at /c/<name>, which federation serves as the Group to a peer that
 * asks for it. The bridge adds the header itself when the page has not (server/federation.ts), by
 * copying the response, and that copy turns a 404 or 403 into a 200 here. Saying it first skips the copy.
 */
export const varyByAccept = () => appendResponseHeader('vary', 'Accept');
