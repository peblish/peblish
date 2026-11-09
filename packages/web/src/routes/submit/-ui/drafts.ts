import { type } from 'arktype';

// "Save draft" keeps what was written in this browser, one draft per person and community (and
// one for no community yet). Nothing goes to the server. A browser can be shared, so a draft is
// keyed by the viewer's actor id as well, and drafts from before that (no person in the key) are
// never read and are removed. Every read and write is guarded: storage can be blocked or full,
// and the composer works without it.

const Draft = type({ type: "'text' | 'link'", title: 'string', url: 'string', body: 'string', nsfw: 'boolean' });
export type Draft = typeof Draft.infer;

/** Whose draft, and for which community (null: none chosen yet). */
export interface DraftScope {
  actorId: string;
  community: string | null;
}

const prefix = 'peblish.draft:';
/** The key before drafts were scoped to a person: `peblish.draft.<community>`. */
const unscopedPrefix = 'peblish.draft.';

const key = ({ actorId, community }: DraftScope) => `${prefix}${actorId}:${community ?? 'none'}`;

export function readDraft(scope: DraftScope): Draft | null {
  try {
    const raw = localStorage.getItem(key(scope));
    if (raw === null) return null;
    const draft = Draft(JSON.parse(raw));
    return draft instanceof type.errors ? null : draft;
  } catch {
    return null;
  }
}

/** False when the browser would not keep it. */
export function writeDraft(scope: DraftScope, draft: Draft): boolean {
  try {
    localStorage.setItem(key(scope), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(scope: DraftScope): void {
  try {
    localStorage.removeItem(key(scope));
  } catch {
    // Nothing to clear if storage is out of reach.
  }
}

/** Removes the drafts that no person owns (the unscoped keys an earlier version wrote). */
export function removeUnscopedDrafts(): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name?.startsWith(unscopedPrefix)) stale.push(name);
    }
    for (const name of stale) localStorage.removeItem(name);
  } catch {
    // Storage out of reach: nothing is read from it either.
  }
}
