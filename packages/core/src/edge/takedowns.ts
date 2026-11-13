import type { OutboxEvent } from '@peblish/schema/events';
import type { Queryable } from '../db/read.ts';
import { publicTags } from './public.ts';
import { actorTag, commentTag, postTag, type Purge } from './tags.ts';

// Which outbox events can stop a signed-out visitor seeing an image the edge may hold, and what
// each purges (tags.ts). Content that can be named is purged by its tag; what cannot be listed
// (a peer's media, a blocked hash, the kill switch) purges every public proxy answer.

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
  'media.blocklist_changed',
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
      // Only an approved peer that is not blocked has its media proxied; anything else purges, as
      // its images may sit on any host and in any content it supplied.
      return event.media === 'approved' && !event.blocked ? null : 'all';
    case 'media.blocklist_changed':
      return event.change === 'added' ? 'all' : null;
    case 'settings.updated':
      return event.keys.includes('remote_media.enabled') ? 'all' : null;
  }
}
