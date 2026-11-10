import { eq } from 'drizzle-orm';
import { communityGate } from '../communities/page.ts';
import { showNsfw } from '../communities/gate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments } from '../db/tables/content.ts';
import { readPost, type Viewer } from '../posts/read.ts';
import type { MediaContent } from './proxy-url.ts';

// Whether the content a signed proxy URL names is still shown to this viewer (C1 of the B07
// review). The proxy asks on every request, so an image dies with its content: a takedown, a
// deletion or the sensitive-content gate reaches a saved URL as it reaches the page. The rules
// are the pages' own (readPost, communityGate), read again here, never a copy of them.
//
// The proxy enforces access, not presentation (CN3 of review 2): the sign-in and age gates hold,
// but a declared viewer's Hide NSFW choice is how a page covers sensitive content (a blurred feed
// card, the gate page), not whether they may open it, so their images load whatever that choice
// is and a revealed card shows its picture.

/**
 * True when `viewer` may open `content`:
 * - a post: it exists in a live community, is neither deleted nor removed (for moderators too:
 *   a takedown stops the image for everyone), and it is not sensitive or the viewer is signed in
 *   with a 16+ declaration;
 * - a comment: neither deleted nor removed, under a post that is shown as above or deleted (a
 *   deleted post is a tombstone whose comments stay listed);
 * - an actor: a community that is live and not sensitive or open to the viewer as a post is, or a
 *   person who is not deleted.
 */
export async function contentShown(content: Pick<MediaContent, 'kind' | 'id'>, viewer: Viewer, q: Queryable = db()): Promise<boolean> {
  switch (content.kind) {
    case 'post': {
      const page = await readPost(content.id, viewer, q, showNsfw);
      return page !== null && page.gate === 'none' && !page.view.deleted && !page.view.removed;
    }
    case 'comment': {
      const [comment] = await q
        .select({ postId: comments.postId, deletedAt: comments.deletedAt, removedAt: comments.removedAt })
        .from(comments)
        .where(eq(comments.id, content.id));
      if (!comment || comment.deletedAt !== null || comment.removedAt !== null) return false;
      const page = await readPost(comment.postId, viewer, q, showNsfw);
      return page !== null && page.gate === 'none' && !page.view.removed;
    }
    case 'actor': {
      const [actor] = await q.select({ kind: actors.kind, deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, content.id));
      if (!actor) return false;
      if (actor.kind === 'Group') return (await communityGate(content.id, viewer, showNsfw, q)) === 'none';
      return (actor.kind === 'Person' || actor.kind === 'Service') && actor.deletedAt === null;
    }
  }
}
