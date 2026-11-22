import { and, eq } from 'drizzle-orm';
import { defineMutation } from '../tx/mutation.ts';
import { threadWatches } from './tables.ts';

// The thread follows' two writes (lane f-notify). Owner and post come from the grant: the owner is
// the acting person, the post the policy checked (authz/actions/watches.ts). Each emits its event
// only when a row changed; nothing federates from them (personal.ts in the schema package).

/** Follows the thread from now on (`since` is the transaction's time); a second follow changes nothing. */
export const watchThread = defineMutation({
  action: 'watch.add',
  emits: ['watch.added'],
  // A ban, a removal or a deleted community can land after authorize().
  recheck: true,
  async run(t, grant) {
    const ownerId = grant.actorId;
    const { postId } = grant.subject;
    const [row] = await t.db
      .insert(threadWatches)
      .values({ ownerId, postId })
      .onConflictDoNothing()
      .returning({ postId: threadWatches.postId });
    if (row) await t.emit({ type: 'watch.added', v: 1, ownerId, postId });
    return { watching: true };
  },
});

/** Stops following the thread; stopping one not followed changes nothing. */
export const unwatchThread = defineMutation({
  action: 'watch.remove',
  emits: ['watch.removed'],
  // A site ban refuses a person's own writes too.
  recheck: true,
  async run(t, grant) {
    const ownerId = grant.actorId;
    const { postId } = grant.subject;
    const [row] = await t.db
      .delete(threadWatches)
      .where(and(eq(threadWatches.ownerId, ownerId), eq(threadWatches.postId, postId)))
      .returning({ postId: threadWatches.postId });
    if (row) await t.emit({ type: 'watch.removed', v: 1, ownerId, postId });
    return { watching: false };
  },
});
