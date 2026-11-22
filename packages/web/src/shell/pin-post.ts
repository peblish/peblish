import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import type { MessageKey } from '../i18n/translate.ts';

// The hydrated side of Pin, Unpin and Move (routes/communities/pins.ts): the directory's forms and
// the sidebar's row menus post the same fields by fetch, then reload the page's data (the shell's
// pins come with it) instead of navigating. Without scripts the forms post themselves.

export type PinFields = { community: string; intent: 'pin' | 'unpin' | 'move'; to?: number };

/** The refusals and web-only codes a pin can end in, each with a pins.error.<code> message. */
export const pinErrors = ['pin.not_followed', 'target.not_found', 'generic', 'network'] as const;
export type PinError = (typeof pinErrors)[number];

const asPinError = (code: string | undefined): PinError => pinErrors.find((known) => known === code) ?? 'generic';
export const pinErrorKey = (code: PinError): MessageKey<'pins'> => `pins.error.${code}`;

/** Posts one pin action; undefined when it worked. */
export async function postPin(fields: PinFields): Promise<PinError | undefined> {
  const body = new URLSearchParams({ community: fields.community, intent: fields.intent });
  if (fields.to !== undefined) body.set('to', String(fields.to));
  try {
    const response = await fetch('/communities/pins', { method: 'POST', body, headers: { accept: 'application/json' } });
    // { ok: true } or { error }, read by hand: this ships with the sidebar on every page, so no validator library.
    const answer: unknown = await response.json();
    if (typeof answer !== 'object' || answer === null) return 'generic';
    if ('ok' in answer && answer.ok === true) return undefined;
    return asPinError('error' in answer && typeof answer.error === 'string' ? answer.error : undefined);
  } catch {
    return 'network';
  }
}

/**
 * One pin action at a time for a control: `run` posts, reloads the router's data and then calls
 * `done` (to put focus back and say what changed); a press while one is on its way does nothing,
 * so the control locks while pending. `error` is the last refusal, cleared by the next success.
 */
export function usePinAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PinError>();
  async function run(fields: PinFields, done?: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      const refused = await postPin(fields);
      setError(refused);
      if (refused) return;
      await router.invalidate();
      // The reloaded rows are drawn in the next frame; focus waits for them.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      done?.();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
