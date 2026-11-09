import { attempt } from '@peblish/core/identity/throttle';
import { hostBlocked } from '@peblish/core/resolve/blocked';
import { findHeld, pointsHere } from '@peblish/core/resolve/local';
import { maxLookupLength, type Held, type Lookup, type ResolveError } from '@peblish/core/resolve/outcome';
import { parseLookup } from '@peblish/core/resolve/parse';
import { readSetting } from '@peblish/core/settings/read';
import { resolveLookup } from '@peblish/federation/resolve/web';
import { commentPath, communityPath, postPath, userPath } from '../../shell/paths.ts';
import type { Outcome } from './-answer.ts';

// The server half of the resolve form (server only: imported by the route's POST handler and its
// tests, never by the page). Only signed-in, verified accounts resolve: a visitor would have this
// server fetch any address. The steps run cheapest first, so a request that is refused costs no
// fetch and no count.

/** The page that shows `held`. */
export function pageOf(held: Held): string {
  switch (held.kind) {
    case 'community':
      return communityPath(held.actor);
    case 'person':
      return userPath(held.actor);
    case 'post':
      return postPath(held.postId);
    case 'comment':
      return commentPath(held.postId, held.commentId);
  }
}

/** The most a lookup form may weigh: the one field is at most 500 characters. */
const maxFormBytes = 4096;

/**
 * What was typed in a request's form: the `q` field, cut a character past the limit so that a
 * too-long lookup still fails to parse. A body that is too big, or no form, is nothing typed.
 */
export async function readLookupText(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxFormBytes) return '';
  try {
    const q = (await request.formData()).get('q');
    return typeof q === 'string' ? q.slice(0, maxLookupLength + 1) : '';
  } catch {
    return '';
  }
}

/** The host a lookup asks, as `hostBlocked` and the pending line name it. */
export const hostOf = (lookup: Lookup): string => (lookup.kind === 'handle' ? lookup.host : new URL(lookup.url).host);

/** What a resolve calls out to, so the order of its steps can be tested without a database or a network. */
export interface Deps {
  held: typeof findHeld;
  /** Whether the lookup names this server (a host or an address of its own). */
  here: typeof pointsHere;
  /** The inbox kill switch: with it off the server talks to no other server, so it resolves nothing. */
  enabled(): Promise<boolean>;
  blocked(host: string): Promise<boolean>;
  /** Counts a lookup against the resolve budget (client address and account); false when over it. */
  count(actorId: string, ip: string | null): Promise<boolean>;
  resolve: typeof resolveLookup;
}

const defaults: Deps = {
  held: findHeld,
  here: pointsHere,
  enabled: () => readSetting('inbox.enabled'),
  blocked: hostBlocked,
  count: async (actorId, ip) => (await attempt('resolve', { ip, id: actorId })).allowed,
  resolve: resolveLookup,
};

export type Who = { actorId: string; emailVerified: boolean; ip: string | null } | null;

const refused = (error: ResolveError): Outcome => ({ ok: false, error });

/**
 * Sends a signed-in person to the local page for what they typed. In order: sign-in, a verified
 * email, a lookup that parses, what we already hold (a hit is uncounted and asks nobody), an
 * address of this server's own that matches nothing (not found, no request), the pause switch,
 * a blocked host, the budget, then the lookup itself.
 */
export async function resolveForm(who: Who, text: string, deps: Deps = defaults): Promise<Outcome> {
  if (!who) return refused('auth.required');
  if (!who.emailVerified) return refused('auth.email_unverified');
  const lookup = parseLookup(text);
  if (!lookup) return refused('input.invalid');
  const held = await deps.held(lookup);
  if (held) return { ok: true, redirect: pageOf(held) };
  if (await deps.here(lookup)) return refused('target.not_found');
  if (!(await deps.enabled())) return refused('resolve.paused');
  if (await deps.blocked(hostOf(lookup))) return refused('instance.blocked');
  if (!(await deps.count(who.actorId, who.ip))) return refused('rate.limited');
  const found = await deps.resolve(lookup);
  return found.ok ? { ok: true, redirect: pageOf(found.found) } : refused(found.error);
}
