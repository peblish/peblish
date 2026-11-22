import type { ActorRef } from '@peblish/schema/views';
import type { FoundCommunity } from './load.ts';

// The finder's two groups, from what the browser already has (the sidebar's joined communities, in the root
// loader's data) and the directory's answer for the text typed. Plain functions, so they are tested alone.

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
 * Joined: the viewer's communities that match (the sidebar's list, which a long one cuts short, plus any the
 * directory found that the viewer joined or asked to join), by name. More communities: the rest of the directory's
 * answer, in its order (most joined first), never one already in Joined.
 */
export function finderGroups({ joined, found, query }: { joined: readonly ActorRef[]; found: readonly FoundCommunity[]; query: string }): {
  joined: FinderEntry[];
  others: FinderEntry[];
} {
  const follow = new Map(found.map((row) => [row.actor.id, row.follow]));
  const mine = new Map<string, FinderEntry>();
  for (const actor of joined) if (matches(actor, query)) mine.set(actor.id, { actor, pending: follow.get(actor.id) === 'pending' });
  for (const row of found)
    if (row.follow !== 'none' && !mine.has(row.actor.id)) mine.set(row.actor.id, { actor: row.actor, pending: row.follow === 'pending' });
  const joinedIds = new Set(joined.map(({ id }) => id));
  const others = found
    .filter((row) => row.follow === 'none' && !joinedIds.has(row.actor.id))
    .map((row) => ({ actor: row.actor, pending: false }));
  return { joined: [...mine.values()].sort(byName), others };
}
