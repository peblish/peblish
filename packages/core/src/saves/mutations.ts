import { and, eq } from 'drizzle-orm';
import { defineMutation } from '../tx/mutation.ts';
import { savedPosts } from './tables.ts';

// The two writes of a person's saves. The owner is the grant's actor and the post its subject, so
// nobody writes another person's rows. Both recheck inside the transaction (a site ban or a post
// removed since authorize() refuses the save). Each emits its personal event only when a row changed;
// the federation consumers ignore both (schema/personal.ts).

/** Saves a post; saving a saved post keeps the first save and emits nothing. */
export const addSave = defineMutation({
  action: 'save.add',
  emits: ['save.added'],
  recheck: true,
  async run(t, grant, _input: void) {
    const ownerId = grant.actorId;
    const { postId } = grant.subject;
    const inserted = await t.db
      .insert(savedPosts)
      .values({ ownerId, postId })
      .onConflictDoNothing()
      .returning({ postId: savedPosts.postId });
    if (inserted.length > 0) await t.emit({ type: 'save.added', v: 1, ownerId, postId });
    return { saved: true };
  },
});

/** Removes the save; removing one that is not there changes nothing and emits nothing. */
export const removeSave = defineMutation({
  action: 'save.remove',
  emits: ['save.removed'],
  recheck: true,
  async run(t, grant, _input: void) {
    const ownerId = grant.actorId;
    const { postId } = grant.subject;
    const deleted = await t.db
      .delete(savedPosts)
      .where(and(eq(savedPosts.ownerId, ownerId), eq(savedPosts.postId, postId)))
      .returning({ postId: savedPosts.postId });
    if (deleted.length > 0) await t.emit({ type: 'save.removed', v: 1, ownerId, postId });
    return { saved: false };
  },
});
