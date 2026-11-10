import { eq } from 'drizzle-orm';
import { communityGate } from '../communities/page.ts';
import { hideNsfw, type NsfwChoice } from '../communities/gate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments } from '../db/tables/content.ts';
import { readPost, type Viewer } from '../posts/read.ts';
import type { MediaContent } from './proxy-url.ts';

// Whether the content a signed proxy URL names is still shown to this viewer (C1 of the B07
// review). The proxy asks on every request, so an image dies with its content: a takedown, a
// deletion or the sensitive-content gate reaches a saved URL as it reaches the page. The rules
// are the pages' own (readPost, communityGate), read again here, never a copy of them.

/**
 * True when `content` is shown to `viewer` with this NSFW choice:
 * - a post: it exists in a live community, is neither deleted nor removed (for moderators too:
 *   a takedown stops the image for everyone), and its gate is open;
 * - a comment: neither deleted nor removed, under a post that is shown as above or deleted (a
 *   deleted post is a tombstone whose comments stay listed);
 * - an actor: a community that is live and whose gate is open, or a person who is not deleted.
 */
export async function contentShown(
  content: MediaContent,
  viewer: Viewer,
  nsfw: NsfwChoice = hideNsfw,
  q: Queryable = db(),
): Promise<boolean> {
  switch (content.kind) {
    case 'post': {
      const page = await readPost(content.id, viewer, q, nsfw);
      return page !== null && page.gate === 'none' && !page.view.deleted && !page.view.removed;
    }
    case 'comment': {
      const [comment] = await q
        .select({ postId: comments.postId, deletedAt: comments.deletedAt, removedAt: comments.removedAt })
        .from(comments)
        .where(eq(comments.id, content.id));
      if (!comment || comment.deletedAt !== null || comment.removedAt !== null) return false;
      const page = await readPost(comment.postId, viewer, q, nsfw);
      return page !== null && page.gate === 'none' && !page.view.removed;
    }
    case 'actor': {
      const [actor] = await q.select({ kind: actors.kind, deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, content.id));
      if (!actor) return false;
      if (actor.kind === 'Group') return (await communityGate(content.id, viewer, nsfw, q)) === 'none';
      return (actor.kind === 'Person' || actor.kind === 'Service') && actor.deletedAt === null;
    }
  }
}
