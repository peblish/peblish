import type { Kept } from './-types.ts';

// Without JavaScript a refused post cannot keep the form in the page: the server answers 303 back
// to /submit and the words must travel with it. A URL cannot carry a 50,000-character body (and
// should not carry anyone's words), so they wait here, in memory, under an unguessable id that
// only the same signed-in person can read. The redirect carries the id (`?flash=`); the page's
// loader reads it. Server only.
//
// It is a convenience, not storage: entries expire, and a restart or a second server process
// loses them, in which case the form comes back empty with the refusal's message, as before.

const ttlMs = 10 * 60_000;
/** Across everyone: each entry can hold a long body, so the whole is bounded. */
const maxEntries = 100;
/** Per person: a refusal replaces older ones after the second. */
const maxPerViewer = 2;
/** Twice a post's limit, so a body that was too long still comes back to be cut down. */
const longestBody = 100_000;

interface Entry {
  actorId: string;
  expires: number;
  kept: Kept;
}

const entries = new Map<string, Entry>();

const clip = (text: string, length: number) => (text.length > length ? text.slice(0, length) : text);

/** Keeps `kept` for `actorId`; the id to put in the redirect. */
export function keepFlash(actorId: string, kept: Kept, now = Date.now()): string {
  // A Map iterates oldest first.
  for (const [id, entry] of entries) if (entry.expires <= now) entries.delete(id);
  const own = [...entries].filter(([, entry]) => entry.actorId === actorId);
  for (const [id] of own.slice(0, Math.max(0, own.length - (maxPerViewer - 1)))) entries.delete(id);
  for (const id of entries.keys()) {
    if (entries.size < maxEntries) break;
    entries.delete(id);
  }
  const id = crypto.randomUUID();
  entries.set(id, {
    actorId,
    expires: now + ttlMs,
    kept: {
      ...kept,
      title: clip(kept.title, 1_000),
      url: clip(kept.url, 4_000),
      body: clip(kept.body, longestBody),
      // Past the 1,000 a post stores, so text refused for its length comes back whole to be shortened.
      alt: clip(kept.alt, 4_000),
    },
  });
  return id;
}

/** What `keepFlash` kept under `id` for this person; null for anyone else, an unknown id or an expired one. */
export function readFlash(id: string | undefined, actorId: string, now = Date.now()): Kept | null {
  const entry = id === undefined ? undefined : entries.get(id);
  return entry !== undefined && entry.actorId === actorId && entry.expires > now ? entry.kept : null;
}
