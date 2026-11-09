import type { Activity, ActorRecord, CommentRecord, ContentObject, FollowActivity, PostRecord } from '../mapping/records.ts';

// The activities peblish sends, as the mapping's records. `toWire` turns each into the Lemmy
// dialect (addressing included, activity.ts in the mapping), so what is built here is only who
// does what to which object, and in which community. `communityApId` is the community the
// activity belongs to, which the mapping addresses it to.

type Base = { id: string; actorApId: string; communityApId: string | null };
const envelope = ({ id, actorApId, communityApId }: Base) => ({ id, actorApId, communityApId, raw: null });

export const create = (base: Base, object: ContentObject): Activity => ({ ...envelope(base), type: 'Create', object });
export const update = (base: Base, object: ContentObject): Activity => ({ ...envelope(base), type: 'Update', object });
/** A profile or community edit: the actor's own document, sent as an Update. */
export const updateActor = (base: Base, actor: ActorRecord): Activity => ({
  ...envelope(base),
  type: 'Update',
  object: { type: 'Actor', actor },
});
export const page = (post: PostRecord): ContentObject => ({ type: 'Page', post });
export const note = (comment: CommentRecord): ContentObject => ({ type: 'Note', comment });

export function remove(base: Base, objectApId: string): Activity {
  return { ...envelope(base), type: 'Delete', objectApId, reason: null };
}

/** The Undo of a Delete, embedding the Delete it reverses (same id, actor and object). */
export function undoDelete(base: Base, deleteId: string, objectApId: string): Activity {
  return { ...envelope(base), type: 'Undo', object: remove({ ...base, id: deleteId }, objectApId) };
}

export function vote(base: Base, value: 1 | -1, targetApId: string): Activity {
  return {
    ...envelope(base),
    type: value === 1 ? 'Like' : 'Dislike',
    vote: { apId: base.id, voterApId: base.actorApId, targetApId, value, raw: null },
  };
}

/** The Undo of a vote, embedding the Like or Dislike it takes back under that vote's own id. */
export function undoVote(base: Base, previous: { id: string; value: 1 | -1 }, targetApId: string): Activity {
  return { ...envelope(base), type: 'Undo', object: vote({ ...base, id: previous.id }, previous.value, targetApId) };
}

export function follow(base: Base, followeeApId: string): FollowActivity {
  return {
    ...envelope({ ...base, communityApId: null }),
    type: 'Follow',
    follow: { apId: base.id, followerApId: base.actorApId, followeeApId },
  };
}

/** The community accepting `followId` of `followerApId`: the Follow it answers travels inside. */
export function accept(base: Base, followId: string, followerApId: string): Activity {
  return {
    ...envelope({ ...base, communityApId: null }),
    type: 'Accept',
    object: follow({ id: followId, actorApId: followerApId, communityApId: null }, base.actorApId),
  };
}

export function undoFollow(base: Base, followId: string, followeeApId: string): Activity {
  return {
    ...envelope({ ...base, communityApId: null }),
    type: 'Undo',
    object: follow({ ...base, id: followId, communityApId: null }, followeeApId),
  };
}

/** A community announcing an activity, or (for Mastodon) the Page itself, to its followers. */
export function announce(base: Base, object: Activity | ContentObject): Activity {
  return { ...envelope(base), type: 'Announce', object };
}
