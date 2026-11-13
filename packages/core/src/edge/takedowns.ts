import type { OutboxEvent } from '@peblish/schema/events';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { mediaBlocklist } from '../mediascan/tables.ts';
import { publicTags } from './public.ts';
import { actorTag, commentTag, hashTag, hostTag, postTag, type Purge } from './tags.ts';

// Which outbox events can stop a signed-out visitor seeing an image the edge may hold, and what
// each purges (tags.ts). Content, a peer domain and an image hash are purged by their tags; only
// the kill switch purges every public proxy answer. A host that becomes denied by being
// discovered (remote/instances.ts ensureInstance) owes its purge where its row is written.

/** The event types the edge purge consumer reads. */
export const takedownEvents = [
  'post.deleted',
  'post.updated',
  'comment.deleted',
  'mod.remove',
  'mod.ban',
  'actor.deleted',
  'actor.updated',
  'peer.updated',
  'media.hash_listed',
  'settings.updated',
] as const satisfies readonly OutboxEvent['type'][];

export type TakedownEvent = Extract<OutboxEvent, { type: (typeof takedownEvents)[number] }>;

/**
 * What `event` purges, or null when it takes nothing away from a signed-out visitor. An edit (a
 * post's, a profile's or a community's) purges only when the content is no longer public as it
 * stands now (a post or community marked sensitive, say): while it is, the proxy would serve the
 * same answers again. Read with `q`, the consumer's transaction.
 */
export async function purgeFor(event: TakedownEvent, q: Queryable): Promise<Purge | null> {
  switch (event.type) {
    case 'post.deleted':
      return [postTag(event.postId)];
    case 'post.updated':
      return (await publicTags({ kind: 'post', id: event.postId }, q)) ? null : [postTag(event.postId)];
    case 'comment.deleted':
      return [commentTag(event.commentId)];
    case 'mod.remove':
      if (!event.removed) return null;
      return [event.target.kind === 'post' ? postTag(event.target.id) : commentTag(event.target.id)];
    case 'mod.ban':
      // A ban without removal leaves the person's content shown to visitors.
      return event.banned && event.removeContent ? [actorTag(event.targetActorId)] : null;
    case 'actor.deleted':
      return [actorTag(event.actorId)];
    case 'actor.updated':
      return (await publicTags({ kind: 'actor', id: event.actorId }, q)) ? null : [actorTag(event.actorId)];
    case 'peer.updated':
      // Only an approved peer that is not blocked has its media proxied. Every public answer carries
      // the tags of its supplier's and its hosts' domains at every level, so this one tag reaches
      // every image hosted at or under the domain and every image of content it supplied.
      return event.media === 'approved' && !event.blocked ? null : [hostTag(event.domain)];
    case 'media.hash_listed': {
      const [entry] = await q.select({ value: mediaBlocklist.value }).from(mediaBlocklist).where(eq(mediaBlocklist.id, event.entryId));
      // An entry removed since it was listed: whatever it held may still be cached, so purge wide.
      return entry ? [hashTag(entry.value)] : 'all';
    }
    case 'settings.updated':
      return event.keys.includes('remote_media.enabled') ? 'all' : null;
  }
}
