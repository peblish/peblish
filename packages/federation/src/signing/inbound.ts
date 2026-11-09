import { db } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { eq } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { parseSignature, signatureVerifies, type SignatureFailure } from './verify.ts';

export type SignatureResult =
  /** `ownerApId` is the actor the key belongs to: the one that signed. */
  { ok: true; keyId: string; ownerApId: string } | { ok: false; reason: SignatureFailure };

type StoredKey = { publicKeyPem: string; ownerApId: string; local: boolean };

async function storedKey(keyId: string): Promise<StoredKey | null> {
  const [row] = await db()
    .select({ publicKeyPem: actorKeys.publicKeyPem, ownerApId: actors.apId, local: actors.local })
    .from(actorKeys)
    .innerJoin(actors, eq(actors.id, actorKeys.actorId))
    .where(eq(actorKeys.keyId, keyId));
  return row ?? null;
}

/** The actor a key id belongs to: the key id without its fragment (Lemmy, PieFed, Mbin, Mastodon all do this). */
function actorOf(keyId: string): string {
  const url = new URL(keyId);
  url.hash = '';
  return url.href;
}

/** A stored actor copy younger than this is not fetched again to look for a rotated or new key. */
export const keyRefetchAfterMs = 60 * 1000;

// Key-refresh attempts, by actor id, so a flood of bad signatures from (or in the name of) one
// actor costs one fetch a minute even when that fetch fails: actors.fetched_at only moves when
// a fetch succeeds, so it cannot throttle an endpoint that is down. Bounded: the oldest attempt
// is forgotten past the cap. Per process, like the NodeInfo failure map; on globalThis because
// the web build can hold two copies of a module.
const refreshAttempts = ((globalThis as { __peblishKeyRefreshes?: Map<string, number> }).__peblishKeyRefreshes ??= new Map());
const refreshAttemptsMax = 10_000;

/** Whether `actorApId` was fetched for its key within the last minute, successfully or not. */
function recentlyFetched(actorApId: string, now: number): boolean {
  const last = refreshAttempts.get(actorApId);
  return last !== undefined && now - last < keyRefetchAfterMs;
}

/** Records that a request for `actorApId` is going out (it moves to the newest end of the map). */
function recordFetch(actorApId: string, now: number): void {
  refreshAttempts.delete(actorApId);
  refreshAttempts.set(actorApId, now);
  if (refreshAttempts.size > refreshAttemptsMax) refreshAttempts.delete(refreshAttempts.keys().next().value!);
}

/** Forgets every recorded refresh attempt (tests). */
export function forgetKeyRefreshes(): void {
  refreshAttempts.clear();
}

/**
 * Checks the HTTP signature of an inbox POST whose exact bytes are `body`, and names the actor
 * that signed it. The key comes from actor_keys; a key we do not hold has its actor fetched
 * (safeFetch) and stored first, and a signature that does not verify under a stored key is
 * tried once more against a freshly fetched copy, since the actor may have rotated it. Two
 * limits keep this from being a way to make us fetch: only the actor a key id names is ever
 * fetched, and an actor is not fetched for its key more than once a minute, whether or not the
 * last fetch worked (FED-B throttles the callers that make us fetch for an actor we do not hold).
 *
 * This proves the signer holds the key of `ownerApId`; whether that actor may do what the
 * activity says is FED-B's (the mapping README's "What the caller checks").
 */
export async function verifyInboundSignature(
  request: Request,
  body: Uint8Array,
  options: { fetch?: Fetcher; now?: number } = {},
): Promise<SignatureResult> {
  const now = options.now ?? Date.now();
  const parsed = parseSignature(request, body, now);
  if (typeof parsed === 'string') return { ok: false, reason: parsed };
  if (!URL.canParse(parsed.keyId)) return { ok: false, reason: 'malformed' };
  const fetched = async (): Promise<StoredKey | null> => {
    const actorApId = actorOf(parsed.keyId);
    if (recentlyFetched(actorApId, now)) return null;
    // A copy that is still fresh makes no request, and so records no attempt.
    const send = options.fetch ?? safeFetch;
    const recording: Fetcher = (url, init) => {
      recordFetch(actorApId, now);
      return send(url, init);
    };
    try {
      await resolveRemoteActor(actorApId, { fetch: recording, maxAgeMs: keyRefetchAfterMs });
    } catch {
      return null;
    }
    return storedKey(parsed.keyId);
  };

  const verified = (key: StoredKey): SignatureResult => ({ ok: true, keyId: parsed.keyId, ownerApId: key.ownerApId });
  let key = await storedKey(parsed.keyId);
  // A key of one of our own actors can only be forged, never presented by a peer.
  if (key?.local) return { ok: false, reason: 'key_unknown' };
  if (key && signatureVerifies(parsed, key.publicKeyPem)) return verified(key);
  // An unknown key, or one that no longer verifies (rotated?): look at the actor's current document.
  key = (await fetched()) ?? key;
  if (!key || key.local) return { ok: false, reason: 'key_unknown' };
  return signatureVerifies(parsed, key.publicKeyPem) ? verified(key) : { ok: false, reason: 'invalid' };
}
