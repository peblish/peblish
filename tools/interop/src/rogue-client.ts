// The runner's side of the rogue peer (rogue.ts): it signs and sends what a scenario asks, and
// reports what reached the rogue's own inboxes.
import { http, ROGUE } from './lab.ts';

export type Received = { ts: string; path: string; status: number; body: unknown };

export const rogue = {
  origin: ROGUE,
  actor: (name: string) => `${ROGUE}/u/${name}`,
  group: (name: string) => `${ROGUE}/c/${name}`,
  /** Signs `activity` as `as` (an actor id on the rogue) and POSTs it to `inbox` (peblish's shared inbox by default). */
  send: (as: string, activity: Record<string, unknown>, inbox?: string) =>
    http<{ status: number; body: string }>('POST', `${ROGUE}/control/send`, { body: { as, inbox, activity } }),
  mode: (settings: { fail503?: number; slowMs?: number }) => http<unknown>('POST', `${ROGUE}/control/mode`, { body: settings }),
  received: () => http<Received[]>('GET', `${ROGUE}/control/received`),
  reset: () => http<unknown>('POST', `${ROGUE}/control/reset`),
};

/** The `type` of an activity's body, and of its object when that is an object. */
export function typesOf(body: unknown): { type: string | null; inner: string | null } {
  if (typeof body !== 'object' || body === null) return { type: null, inner: null };
  const activity = body as { type?: unknown; object?: unknown };
  const object = activity.object;
  return {
    type: typeof activity.type === 'string' ? activity.type : null,
    inner:
      typeof object === 'object' && object !== null && typeof (object as { type?: unknown }).type === 'string'
        ? (object as { type: string }).type
        : null,
  };
}
