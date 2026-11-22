import type { ActorRef } from '@peblish/schema/views';
import type { FinderAnswer } from './load.ts';

// The finder's two groups, from the server's answer for the text typed (load.ts): the viewer's own communities it
// lists them, and the directory's first page. Nothing else is drawn, so nothing the server withholds from this
// viewer shows. Plain functions, so they are tested alone.

export interface FinderEntry {
  actor: ActorRef;
  /** A join still waiting for the community's answer (the directory says so; the sidebar does not). */
  pending: boolean;
}

/** Lowercase, accents and a leading "!" dropped: how a query and a name compare. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^!/, '');

/** Whether a community answers the query as the directory's search does: its name, display name or handle (with the host). */
export function matches(actor: Pick<ActorRef, 'name' | 'displayName' | 'handle'>, query: string): boolean {
  const q = fold(query);
  return q === '' || [actor.name, actor.displayName ?? '', actor.handle].some((text) => fold(text).includes(q));
}

const byName = (a: FinderEntry, b: FinderEntry) => a.actor.name.localeCompare(b.actor.name) || a.actor.id.localeCompare(b.actor.id);

/**
 * Joined: the viewer's own communities the server listed that the text matches (a pasted handle finds one by its
 * handle), by name. More communities: the rest of the directory's answer, in its order (most joined first), never
 * one of the viewer's own, so one the server left out of Joined (blocked by the viewer) is not shown here either.
 */
export function finderGroups({
  followed,
  found,
  query,
}: {
  followed: FinderAnswer['followed'];
  found: FinderAnswer['rows'];
  query: string;
}): {
  joined: FinderEntry[];
  others: FinderEntry[];
} {
  const joined = followed
    .filter(({ actor }) => matches(actor, query))
    .map(({ actor, follow }) => ({ actor, pending: follow === 'pending' }))
    .sort(byName);
  const mine = new Set(followed.map(({ actor }) => actor.id));
  const others = found
    .filter((row) => row.follow === 'none' && !mine.has(row.actor.id))
    .map((row) => ({ actor: row.actor, pending: false }));
  return { joined, others };
}
