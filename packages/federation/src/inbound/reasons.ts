import type { RefusalReason } from '@peblish/schema/refusal';

// Why an inbound activity changed nothing. A core policy or a mutation's recheck says no with
// a RefusalReason (`mod.moderator_required`, `community.banned`, `post.locked`); everything the
// inbound pipeline decides before a policy runs (origins, who announced, what we do not map or
// do not hold) is in this closed set. Both land in inbox_raw.error as the bare reason, so a
// test, a log line and the requeue function (queue.ts) all name a skip the same way.

export const inboundReasons = {
  'activity.origin_mismatch': 'The activity id and its actor are on different origins: a server speaks only for its own people.',
  'embedded.actor_mismatch': 'An Undo reverses an activity of another actor.',
  'embedded.unverifiable':
    'An announced activity from another origin could not be read from that origin, so only the announcer vouched for it.',
  'object.origin_mismatch': 'The created or updated object is not on its author’s origin.',
  'object.author_mismatch': 'The object is attributed to someone other than the activity’s actor.',
  'object.exists': 'The object is already stored here (a redelivered Create).',
  'object.unsupported': 'The object type is not one peblish stores.',
  'community.mismatch': 'The activity claims a community other than the one its target belongs to.',
  'community.unannounced': 'Content in a remote community counts only when that community announces it.',
  'announce.person': 'An Announce by a person is a boost, not a community’s relay, and is ignored.',
  'announce.bare_iri': 'An Announce of a bare IRI is not read yet (a boost, or a Mastodon share).',
  'announce.unfollowed': 'The announcing community has no follower here, so nothing it announces was asked for.',
  'announce.empty': 'The Announce carries no activity.',
  'echo.own_activity': 'The activity is one of ours coming back through a relay.',
  duplicate: 'Another copy of this activity was applied already.',
  'target.missing': 'The object the activity is about is not stored here (yet); it is applied again when it arrives.',
  'actor.unresolvable': 'An actor the activity names could not be fetched or is not a valid actor.',
  'actor.group_cannot_act':
    'A community does not author posts, comments or votes: its Announce wraps a person’s activity, and that person is the author.',
  'actor.unknown': 'An actor update for an actor this server does not hold.',
  'actor.update_unauthorized': 'Only the actor itself, or its community announcing the change, may update an actor.',
  'type.unhandled': 'The activity type is not one peblish reads.',
  'type.question': 'Polls (Question) are not stored yet.',
  'content.nsfw_rejected': 'Remote sensitive content is refused by default; a setting to accept it comes with the admin controls.',
  'note.no_local_community': 'A top-level Note that is not addressed to a community here is not a post.',
  'vote.unchanged': 'The voter already has this vote, or has none to take back.',
  'moderators.local_collection': 'A local community’s moderators change here, not by a peer’s Add or Remove.',
  'moderators.unreachable': 'The community’s moderators collection could not be read.',
  'collection.unknown': 'The activity targets a collection peblish does not read.',
  'collection.mismatch': 'The target is not the featured collection of the post’s community.',
  'block.instance_unsupported': 'A ban of a whole instance is read once site bans exist.',
  'block.expired': 'The ban had already ended when it arrived.',
  'delete.target_unsupported': 'A Delete of an actor counts only from that actor itself.',
  'accept.unverifiable': 'An Accept that names its Follow by IRI only cannot be matched to the follower it accepts, so it is not read.',
  'follow.target_unsupported': 'Only local communities take followers.',
  'undo.unsupported': 'This Undo reverses something peblish does not undo.',
  'report.not_local': 'A report counts only about content stored here, in a community hosted here.',
  'flag.not_handled': 'Reports are handled by the reports lane; the Flag is recorded and not acted on.',
  'comments.unavailable': 'Comments are not wired into the inbound pipeline yet.',
} as const;

export type InboundReason = keyof typeof inboundReasons;
export type SkipReason = InboundReason | RefusalReason;

/**
 * Thrown by a handler (preparing or applying) when the activity is valid but changes nothing:
 * the pipeline records the reason on the inbox row and, inside the transaction, rolls the
 * attempt back. `detail` is what a requeue looks for (the missing object's ap_id).
 */
export class Skipped extends Error {
  override readonly name = 'Skipped';
  readonly reason: SkipReason;
  readonly detail: string | undefined;

  constructor(reason: SkipReason, detail?: string) {
    super(detail ? `${reason} ${detail}` : reason);
    this.reason = reason;
    this.detail = detail;
  }

  /** What inbox_raw.error holds: the reason, then the detail when there is one. */
  get recorded(): string {
    return this.message;
  }
}

export const skip = (reason: SkipReason, detail?: string): Skipped => new Skipped(reason, detail);

/** The error text a skipped row waiting on `apId` carries, for the requeue. */
export const missingTarget = (apId: string): string => `target.missing ${apId}`;
