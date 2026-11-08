import type { Actor, Comment, Post, Vote } from '@peblish/schema/entities';

// What a wire object maps to: the stored fields of its row (the schema entity plus the
// table's other columns), with references to other rows kept as ap_ids. The store resolves
// those to uuids, assigns id, local and instance_id, and keeps `raw` as received. Nothing
// here touches the database, so the same records serve the inbox, the fixtures and import.

export type ActorRecord = Pick<
  Actor,
  | 'apId'
  | 'kind'
  | 'name'
  | 'displayName'
  | 'summaryHtml'
  | 'inboxUrl'
  | 'sharedInboxUrl'
  | 'sensitive'
  | 'nsfl'
  | 'discoverable'
  | 'indexable'
  | 'postingRestrictedToMods'
  | 'postingWarning'
  | 'raw'
> & {
  summaryMd: string | null;
  outboxUrl: string | null;
  followersUrl: string | null;
  featuredUrl: string | null;
  /** Group only: the moderators collection (Lemmy's attributedTo, PieFed's moderators). */
  moderatorsUrl: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  /** Group only: the community's languages as ISO 639 codes, for community_languages; empty when it names none. */
  languages: string[];
  /** Lemmy and PieFed publish bot accounts as Service. */
  bot: boolean;
  publishedAt: Date | null;
  updatedAt: Date | null;
  /** The public half of the actor's signing key, for actor_keys. */
  publicKey: { keyId: string; pem: string } | null;
};

/**
 * `urlContentType` is the attachment's mediaType, or `image/*` (IMAGE_TYPE in content.ts) for
 * an Image attachment that names none, so an image post stays one; `altText` is an Image
 * attachment's name and `thumbnailUrl` the Page's preview `image`.
 */
export type PostRecord = Pick<
  Post,
  | 'apId'
  | 'title'
  | 'url'
  | 'urlContentType'
  | 'altText'
  | 'thumbnailUrl'
  | 'bodyMd'
  | 'contentHtml'
  | 'sensitive'
  | 'nsfl'
  | 'editedAt'
  | 'raw'
> & {
  authorApId: string;
  communityApId: string;
  /** ISO 639 code; null when the peer sent none. */
  language: string | null;
  /** Lemmy 0.19 leaves commentsEnabled out and federates locks as Lock; null means the Page did not say, so keep the stored value. */
  locked: boolean | null;
  /** `stickied`, null when absent (Lemmy 0.19 federates pins through the featured collection). */
  featuredCommunity: boolean | null;
  /** Null when the peer sent no `published`; the store uses the receive time. */
  publishedAt: Date | null;
};

export type CommentRecord = Pick<Comment, 'apId' | 'bodyMd' | 'contentHtml' | 'editedAt' | 'raw'> & {
  authorApId: string;
  /** The post or comment replied to. The store resolves which one, then postId, parentId and path. */
  inReplyToApId: string;
  /** The community named in `audience` (comments are stored without one; the store checks it against the post's). */
  communityApId: string | null;
  language: string | null;
  distinguished: boolean;
  publishedAt: Date | null;
};

/** A Like (+1) or Dislike (-1). The ap_id is the activity's id. */
export type VoteRecord = Pick<Vote, 'apId' | 'value' | 'raw'> & {
  voterApId: string;
  /** A post or a comment; the store resolves which. */
  targetApId: string;
};

/** A follows row; the state comes from the Accept, not from the Follow. */
export type FollowRecord = { apId: string; followerApId: string; followeeApId: string };

/** A reports row from a Flag. The category is lane REP's to assign; peers send only a reason. */
export type ReportRecord = {
  apId: string;
  reporterApId: string;
  targetApId: string;
  communityApId: string | null;
  reason: string | null;
  raw: unknown;
};

/** A community's moderators collection, mirrored into community_moderators (source 'remote'). */
export type ModeratorsRecord = { apId: string; moderatorApIds: string[] };

/** A post or a comment, as carried by Create, Update and the Announce(Page) Mastodon reads. */
export type ContentObject = { type: 'Page'; post: PostRecord } | { type: 'Note'; comment: CommentRecord };

/** A profile or community edit: an Update that carries the actor's document. */
export type ActorObject = { type: 'Actor'; actor: ActorRecord };

type Envelope = {
  /** The activity id: dedupe key and activities.ap_id. */
  id: string;
  actorApId: string;
  /** The community the activity claims (`audience`, or the Group in `to` and `cc`); FED-B verifies it. */
  communityApId: string | null;
  raw: unknown;
};

export type FollowActivity = Envelope & { type: 'Follow'; follow: FollowRecord };

/** The activities the mapping reads and writes, each with the record it carries. */
export type Activity =
  | (Envelope & { type: 'Create' | 'Update'; object: ContentObject })
  | (Envelope & { type: 'Update'; object: ActorObject })
  | (Envelope & { type: 'Like' | 'Dislike'; vote: VoteRecord })
  | FollowActivity
  | (Envelope & { type: 'Accept' | 'Reject'; object: FollowActivity })
  | (Envelope & { type: 'Announce'; object: Activity | ContentObject })
  /** A Delete by someone other than the author is a moderator's removal, with the reason in `summary`. */
  | (Envelope & { type: 'Delete'; objectApId: string; reason: string | null })
  | (Envelope & { type: 'Undo'; object: Activity })
  | (Envelope & { type: 'Lock'; objectApId: string })
  | (Envelope & { type: 'Flag'; report: ReportRecord })
  /** Pin and unpin (target: the featured collection) or moderator changes (target: the moderators collection). */
  | (Envelope & { type: 'Add' | 'Remove'; objectApId: string; targetApId: string })
  /** A community ban (target: the community) or a site ban (target: the instance). */
  | (Envelope & {
      type: 'Block';
      objectApId: string;
      targetApId: string;
      reason: string | null;
      /** Absent on the Block inside Lemmy's Undo, so null keeps that distinction. */
      removeData: boolean | null;
      expires: Date | null;
    });

/** Everything a top-level wire document maps to. */
export type Mapped =
  | { kind: 'actor'; actor: ActorRecord }
  | { kind: 'post'; post: PostRecord }
  | { kind: 'comment'; comment: CommentRecord }
  | { kind: 'moderators'; moderators: ModeratorsRecord }
  | { kind: 'activity'; activity: Activity };
