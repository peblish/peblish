import { attempt } from '@peblish/core/identity/throttle';
import { hostBlocked } from '@peblish/core/resolve/blocked';
import { ageGated, findHeld, heldHostBlocked, pointsHere } from '@peblish/core/resolve/local';
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
  /** Whether what was held or found is age-gated (sensitive or NSFL, itself or its community). */
  gated: typeof ageGated;
  /** Whether what was held or found lives on a host this server or the person blocks, whatever address named it. */
  hostBlocked: typeof heldHostBlocked;
  /** Counts a lookup against the resolve budget (client address and account); false when over it. */
  count(actorId: string, ip: string | null): Promise<boolean>;
  resolve: typeof resolveLookup;
}

const defaults: Deps = {
  held: findHeld,
  here: pointsHere,
  enabled: () => readSetting('inbox.enabled'),
  blocked: hostBlocked,
  gated: ageGated,
  hostBlocked: heldHostBlocked,
  count: async (actorId, ip) => (await attempt('resolve', { ip, id: actorId })).allowed,
  resolve: resolveLookup,
};

/** The person asking: `declared` is their 16+ declaration. */
export type Who = { actorId: string; emailVerified: boolean; declared: boolean; ip: string | null } | null;

const refused = (error: ResolveError): Outcome => ({ ok: false, error });

/**
 * The page for `held`, unless it is age-gated and the person has not declared 16+ (for them it is
 * not there), or it lives on a host this server or they block.
 */
async function shown(held: Held, who: NonNullable<Who>, deps: Deps): Promise<Outcome> {
  if (!who.declared && (await deps.gated(held))) return refused('target.not_found');
  if (await deps.hostBlocked(held, who.actorId)) return refused('instance.blocked');
  return { ok: true, redirect: pageOf(held) };
}

/**
 * Sends a signed-in person to the local page for what they typed. In order: sign-in, a verified
 * email, a lookup that parses, a blocked host (nothing held there is answered either), what we
 * already hold (a hit is uncounted and asks nobody), an address of this server's own that matches
 * nothing (not found, no request), the pause switch, the budget, then the lookup itself. What is
 * held or found passes the age gate and its own host's blocks (shown) before its page is given.
 */
export async function resolveForm(who: Who, text: string, deps: Deps = defaults): Promise<Outcome> {
  if (!who) return refused('auth.required');
  if (!who.emailVerified) return refused('auth.email_unverified');
  const lookup = parseLookup(text);
  if (!lookup) return refused('input.invalid');
  if (await deps.blocked(hostOf(lookup))) return refused('instance.blocked');
  const held = await deps.held(lookup);
  if (held) return shown(held, who, deps);
  if (await deps.here(lookup)) return refused('target.not_found');
  if (!(await deps.enabled())) return refused('resolve.paused');
  if (!(await deps.count(who.actorId, who.ip))) return refused('rate.limited');
  const found = await deps.resolve(lookup);
  if (found.ok) return shown(found.found, who, deps);
  // The resolver refuses a post in a sensitive community for everyone; to someone who has not declared 16+ it is not there.
  return refused(found.error === 'content.nsfw_rejected' && !who.declared ? 'target.not_found' : found.error);
}
