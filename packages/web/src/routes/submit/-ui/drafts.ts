import { type } from 'arktype';

// "Save draft" keeps what was written in this browser, one draft per community (and one for
// no community yet). Nothing goes to the server. Every read and write is guarded: storage can
// be blocked or full, and the composer works without it.

const Draft = type({ type: "'text' | 'link'", title: 'string', url: 'string', body: 'string', nsfw: 'boolean' });
export type Draft = typeof Draft.infer;

const key = (community: string | null) => `peblish.draft.${community ?? 'none'}`;

export function readDraft(community: string | null): Draft | null {
  try {
    const raw = localStorage.getItem(key(community));
    if (raw === null) return null;
    const draft = Draft(JSON.parse(raw));
    return draft instanceof type.errors ? null : draft;
  } catch {
    return null;
  }
}

/** False when the browser would not keep it. */
export function writeDraft(community: string | null, draft: Draft): boolean {
  try {
    localStorage.setItem(key(community), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(community: string | null): void {
  try {
    localStorage.removeItem(key(community));
  } catch {
    // Nothing to clear if storage is out of reach.
  }
}
