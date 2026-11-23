import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import type { MessageKey } from '../i18n/translate.ts';

// The hydrated side of Pin, Unpin and Move (routes/communities/pins.ts): the directory's forms and
// the sidebar's row menus post the same fields by fetch, then reload the page's data (the shell's
// pins come with it) instead of navigating. Without scripts the forms post themselves. A move names
// only its direction; where the pin went comes back in the answer, as committed.

export type PinFields = { community: string; intent: 'pin' | 'unpin' } | { community: string; intent: 'move'; direction: 'up' | 'down' };

/** Where a move left the pin: its place among the viewer's shown pins and their order (community ids), as committed. */
export type PinPlace = { position: number; order: readonly string[] };

/** The refusals and web-only codes a pin can end in, each with a pins.error.<code> message. */
export const pinErrors = ['pin.not_followed', 'target.not_found', 'generic', 'network'] as const;
export type PinError = (typeof pinErrors)[number];

const asPinError = (code: string | undefined): PinError => pinErrors.find((known) => known === code) ?? 'generic';
export const pinErrorKey = (code: PinError): MessageKey<'pins'> => `pins.error.${code}`;

/** A move's place in an answer, when it holds one. */
const placeOf = (answer: object): PinPlace | null =>
  'position' in answer &&
  typeof answer.position === 'number' &&
  'order' in answer &&
  Array.isArray(answer.order) &&
  answer.order.every((id): id is string => typeof id === 'string')
    ? { position: answer.position, order: answer.order }
    : null;

/** Posts one pin action: its refusal, or what it committed (a move's place; null for Pin and Unpin). */
export async function postPin(fields: PinFields): Promise<{ error: PinError } | { place: PinPlace | null }> {
  const body = new URLSearchParams({ community: fields.community, intent: fields.intent });
  if (fields.intent === 'move') body.set('direction', fields.direction);
  try {
    const response = await fetch('/communities/pins', { method: 'POST', body, headers: { accept: 'application/json' } });
    // { ok: true } (a move's with position and order) or { error }, read by hand: this ships with the sidebar on
    // every page, so no validator library.
    const answer: unknown = await response.json();
    if (typeof answer !== 'object' || answer === null) return { error: 'generic' };
    if ('ok' in answer && answer.ok === true) return { place: placeOf(answer) };
    return { error: asPinError('error' in answer && typeof answer.error === 'string' ? answer.error : undefined) };
  } catch {
    return { error: 'network' };
  }
}

/**
 * One pin action at a time for a control: `run` posts, reloads the router's data and then calls
 * `done` with what it committed (to put focus back and say what changed); a press while one is on
 * its way does nothing, so the control locks while pending. `error` is the last refusal, cleared when
 * the next action starts, so the same refusal twice is said twice.
 */
export function usePinAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PinError>();
  async function run(fields: PinFields, done?: (place: PinPlace | null) => void) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const answer = await postPin(fields);
      if ('error' in answer) return setError(answer.error);
      await router.invalidate();
      // The reloaded rows are drawn in the next frame; focus waits for them.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      done?.(answer.place);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
