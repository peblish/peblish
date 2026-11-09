import type { PeerInput } from '@peblish/core/peers/update';
import { type } from 'arktype';

// The Peers tab's form: one POST with an `intent` per button (a row's buttons share its reason box).

export const Body = type({
  intent: "'approve' | 'quarantine' | 'purge' | 'pause' | 'resume' | 'block' | 'unblock'",
  domain: 'string',
  'reason?': 'string',
});
export type Body = typeof Body.infer;

/** What each button asks of updatePeer. */
export const changes = {
  approve: { media: 'approved' },
  quarantine: { media: 'quarantined' },
  purge: { purge: true },
  pause: { inboxPaused: true },
  resume: { inboxPaused: false },
  block: { blocked: true },
  unblock: { blocked: false },
} as const satisfies Record<Body['intent'], PeerInput>;

/**
 * A host as an admin types it: a bare host or a pasted URL, any case, with or without `www` left
 * alone. Null when it is neither (the policy then says peer.invalid_domain for what is left).
 */
export function hostFrom(input: string): string {
  const text = input.trim().toLowerCase();
  return URL.parse(text)?.host || URL.parse(`https://${text}`)?.host || text;
}
