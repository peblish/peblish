import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';

// What a lookup is and what it can come to (lane DISC). Core holds the types and the database
// half (local.ts); the network half is federation's resolve/web.ts, the one entry web imports.

/** What a person typed into the resolve form: a handle or a link. */
export type Lookup = { kind: 'handle'; sigil: '!' | '@' | null; name: string; host: string } | { kind: 'url'; url: string };

/** What we already hold for a lookup, and so the local page to send the person to. */
export type Held =
  { kind: 'community' | 'person'; actor: ActorRef } | { kind: 'post'; postId: Uuid } | { kind: 'comment'; postId: Uuid; commentId: Uuid };

/**
 * Every code the resolve form can answer with, each with an `error.<code>` message in
 * i18n/directory.json. The first five are the handler's own (before any fetch), the rest come
 * from the resolver.
 */
export const resolveErrors = [
  'auth.required',
  'auth.email_unverified',
  'input.invalid',
  'resolve.paused',
  'rate.limited',
  'instance.blocked',
  'target.not_found',
  'target.gone',
  'target.removed',
  'peer.unreachable',
  'peer.invalid',
  'content.nsfw_rejected',
  'object.unvouched',
  'object.unsupported',
  'resolve.too_large',
  'generic',
] as const;

export type ResolveError = (typeof resolveErrors)[number];

const known: ReadonlySet<string> = new Set(resolveErrors);

/** A code from the address or the server, as one the page has a message for; anything else is `generic`. */
export function asResolveError(code: string | null | undefined): ResolveError | undefined {
  if (!code) return undefined;
  return known.has(code) ? (code as ResolveError) : 'generic';
}

/** The most characters a lookup may have. */
export const maxLookupLength = 500;
