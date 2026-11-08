import { type } from 'arktype';
import { Authority } from './authz.ts';
import { IsoDate, Uuid } from './ids.ts';

// Owned by lane AZ after G0. One immutable modlog row; the table refuses updates and deletes.
export const ModAction = type({
  id: Uuid,
  /** The mod.* action name, such as 'mod.remove' or 'mod.site_ban' (recheck keys on the prefix). */
  action: 'string',
  /** Who acted; null once that actor row is purged (or when only an announcing community is known), when actorApId still names them. */
  actorId: Uuid.or('null'),
  actorApId: 'string',
  /** Null once the community row is purged; communityApId keeps naming it (set whenever communityId was). */
  communityId: Uuid.or('null'),
  communityApId: 'string | null',
  targetActorId: Uuid.or('null'),
  targetPostId: Uuid.or('null'),
  targetCommentId: Uuid.or('null'),
  /** Names the target; set whenever one of the target ids was. */
  targetApId: 'string | null',
  /** Statement of reasons shown to the affected user. */
  reason: 'string | null',
  authority: Authority,
  createdAt: 'Date',
});
export type ModAction = typeof ModAction.infer;

/** What the moderation mutations take besides the target (which comes from the grant). */
export const ModInput = type({
  /** Statement of reasons; the remote activity's summary for an inbound action. */
  'reason?': 'string <= 10000 | null',
  /** False keeps the entry out of the public modlog (sensitive cases); default true. */
  'public?': 'boolean',
  /** The federated activity that carried the action, for inbound actions. */
  'activityApId?': 'string.url | null',
});
export type ModInput = typeof ModInput.infer;

export const BanInput = ModInput.and({
  /** When the ban ends; null or absent for a permanent ban. Must be in the future. */
  'expiresAt?': IsoDate.or('null'),
  /** Also remove the actor's posts and comments in the community. */
  'removeContent?': 'boolean',
});
export type BanInput = typeof BanInput.infer;

/** Extra facts kept in modlog.details; other writers may add keys, which readers ignore. */
export const ModlogDetails = type({
  /** False keeps the row out of the public modlog; true when absent. */
  'public?': 'boolean',
  /** Bans: when the ban ends, null for permanent. */
  'expiresAt?': IsoDate.or('null'),
  /** Bans: whether the actor's content in the community was removed with it, and how much. */
  'removeContent?': 'boolean',
  'removedPosts?': 'number.integer >= 0',
  'removedComments?': 'number.integer >= 0',
});
export type ModlogDetails = typeof ModlogDetails.infer;

/** Who reads the modlog: everyone sees public entries; staff (moderators, admins) see all. */
export const ModlogAudience = type("'public' | 'staff'");
export type ModlogAudience = typeof ModlogAudience.infer;

/** Filters of the modlog read model; every one is optional. The time range is [since, until). */
export const ModlogFilter = type({
  'communityId?': Uuid,
  'actorId?': Uuid,
  /** One mod.* action name, such as 'mod.remove'. */
  'action?': 'string',
  'since?': IsoDate,
  'until?': IsoDate,
  /** Newest first; 50 when absent. */
  'limit?': '1 <= number.integer <= 200',
});
export type ModlogFilter = typeof ModlogFilter.infer;

/** One row of the modlog read model. */
export const ModlogEntry = type({
  id: Uuid,
  action: 'string',
  actorId: Uuid.or('null'),
  actorApId: 'string',
  communityId: Uuid.or('null'),
  communityApId: 'string | null',
  targetActorId: Uuid.or('null'),
  targetPostId: Uuid.or('null'),
  targetCommentId: Uuid.or('null'),
  targetApId: 'string | null',
  /** Null when there is none or when it is withheld. */
  reason: 'string | null',
  /** True when the row has a reason this view leaves out: it came from an instance not marked trusted. */
  reasonWithheld: 'boolean',
  authority: Authority,
  details: ModlogDetails,
  public: 'boolean',
  createdAt: IsoDate,
});
export type ModlogEntry = typeof ModlogEntry.infer;
